import { randomBytes } from 'crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { configModuleOptions } from '../config/config-module.options';
import { DatabaseModule } from '../database/database.module';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from '../video-processing/video-processing.queue';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoUploadsService } from './video-uploads.service';
import { videoOriginalKey, videoPrefix } from './video-storage-keys';
import { VideosModule } from './videos.module';

describe('VideoUploadsService (integration, Postgres + MinIO + Redis)', () => {
  jest.setTimeout(60000);

  let module: TestingModule;
  let dataSource: DataSource;
  let uploads: VideoUploadsService;
  let storage: StorageService;
  let queue: Queue;
  // id → upload_id, captured at creation: beforeEach wipes the rows
  const createdUploads = new Map<string, string>();

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot(configModuleOptions),
        DatabaseModule,
        // Channel#user needs User metadata; in AppModule UsersModule registers it
        TypeOrmModule.forFeature([User]),
        VideosModule,
      ],
    }).compile();
    dataSource = module.get(DataSource);
    uploads = module.get(VideoUploadsService);
    storage = module.get(StorageService);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    for (const [id, uploadId] of createdUploads) {
      await storage.abortMultipartUpload(videoOriginalKey(id), uploadId);
      await storage.deletePrefix(videoPrefix(id));
    }
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function createChannelOwner(): Promise<{
    user: User;
    channel: Channel;
  }> {
    const user = await dataSource.getRepository(User).save({
      email: 'uploads_it@example.com',
      password: 'hashed',
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: 'Uploads IT',
      nickname: 'uploads-it',
      user_id: user.id,
    });
    return { user, channel };
  }

  it('should persist the draft and open a real multipart upload in MinIO', async () => {
    const { user, channel } = await createChannelOwner();

    const { video, upload } = await uploads.initiate(user.id, {
      file_name: 'clip.mp4',
      mime_type: 'video/mp4',
      size: 1048576,
    });
    createdUploads.set(video.id, video.upload_id);

    const row = await dataSource.getRepository(Video).findOneByOrFail({
      id: video.id,
    });
    expect(row).toMatchObject({
      channel_id: channel.id,
      status: VideoStatus.Draft,
      title: 'clip',
    });
    expect(row.upload_id).toEqual(expect.any(String));
    expect(upload).toEqual({ part_size: 67108864, part_count: 1 });
    // `null` would mean the multipart upload does not exist
    await expect(
      storage.listParts(videoOriginalKey(video.id), row.upload_id),
    ).resolves.toEqual([]);
  });

  it('should report exactly the parts PUT through presigned part URLs', async () => {
    const { user } = await createChannelOwner();
    const { video } = await uploads.initiate(user.id, {
      file_name: 'clip.mp4',
      mime_type: 'video/mp4',
      size: 2 * 67108864 + 1,
    });
    createdUploads.set(video.id, video.upload_id);
    const key = videoOriginalKey(video.id);

    for (const [partNumber, size] of [
      [1, 5 * 1024 * 1024],
      [3, 1024 * 1024],
    ] as const) {
      const { url } = await storage.presignUploadPart(
        key,
        video.upload_id,
        partNumber,
      );
      const res = await fetch(url, {
        method: 'PUT',
        body: new Uint8Array(randomBytes(size)),
      });
      expect(res.status).toBe(200);
    }

    const status = await uploads.getUploadStatus(user.id, video.id);

    expect(status).toEqual({
      part_size: 67108864,
      part_count: 3,
      uploaded_parts: [
        { part_number: 1, size: 5 * 1024 * 1024 },
        { part_number: 3, size: 1024 * 1024 },
      ],
    });
  });

  it('should sign part URLs that accept a 5 MiB PUT listed afterwards', async () => {
    const { user } = await createChannelOwner();
    const { video } = await uploads.initiate(user.id, {
      file_name: 'clip.mp4',
      mime_type: 'video/mp4',
      size: 2 * 67108864 + 1,
    });
    createdUploads.set(video.id, video.upload_id);

    const { parts } = await uploads.presignParts(user.id, video.id, [1]);
    const res = await fetch(parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(randomBytes(5 * 1024 * 1024)),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBeTruthy();
    await expect(
      storage.listParts(videoOriginalKey(video.id), video.upload_id),
    ).resolves.toEqual([
      expect.objectContaining({ partNumber: 1, size: 5 * 1024 * 1024 }),
    ]);
  });

  it('should assemble 64 MiB + remainder, move to processing and enqueue the job', async () => {
    const { user } = await createChannelOwner();
    const declaredSize = 67108864 + 1048576;
    const { video } = await uploads.initiate(user.id, {
      file_name: 'clip.mp4',
      mime_type: 'video/mp4',
      size: declaredSize,
    });
    createdUploads.set(video.id, video.upload_id);

    const { parts } = await uploads.presignParts(user.id, video.id, [1, 2]);
    for (const [part, size] of [
      [parts[0], 67108864],
      [parts[1], 1048576],
    ] as const) {
      const res = await fetch(part.url, {
        method: 'PUT',
        body: new Uint8Array(randomBytes(size)),
      });
      expect(res.status).toBe(200);
    }

    const completed = await uploads.complete(user.id, video.id);

    expect(completed.status).toBe(VideoStatus.Processing);
    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.Processing);
    expect(row.processing_started_at).toBeInstanceOf(Date);
    await expect(
      storage.headObject(videoOriginalKey(video.id)),
    ).resolves.toEqual({ contentLength: declaredSize });
    const job = await queue.getJob(video.id);
    expect(job).toBeDefined();
    expect(job!.name).toBe(PROCESS_VIDEO_JOB);
    expect(job!.data).toEqual({ videoId: video.id });
  });
});
