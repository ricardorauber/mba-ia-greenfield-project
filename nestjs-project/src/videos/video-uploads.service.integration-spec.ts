import { randomBytes } from 'crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { configModuleOptions } from '../config/config-module.options';
import { DatabaseModule } from '../database/database.module';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoUploadsService } from './video-uploads.service';
import { videoOriginalKey, videoPrefix } from './video-storage-keys';
import { VideosModule } from './videos.module';

describe('VideoUploadsService (integration, Postgres + MinIO)', () => {
  jest.setTimeout(30000);

  let module: TestingModule;
  let dataSource: DataSource;
  let uploads: VideoUploadsService;
  let storage: StorageService;
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
  });

  afterAll(async () => {
    for (const [id, uploadId] of createdUploads) {
      await storage.abortMultipartUpload(videoOriginalKey(id), uploadId);
      await storage.deletePrefix(videoPrefix(id));
    }
    await cleanAllTables(dataSource);
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
});
