import { randomUUID } from 'crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { DataSource, type Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { configModuleOptions } from '../../config/config-module.options';
import { DatabaseModule } from '../../database/database.module';
import { StorageModule } from '../../storage/storage.module';
import { StorageService } from '../../storage/storage.service';
import { cleanAllTables } from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { UsersModule } from '../../users/users.module';
import { Video, VideoStatus } from '../../videos/entities/video.entity';
import { videoOriginalKey, videoPrefix } from '../../videos/video-storage-keys';
import { VideosModule } from '../../videos/videos.module';
import { VideoProcessingQueueModule } from '../video-processing-queue.module';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from '../video-processing.queue';
import { VideoReconciliationService } from './video-reconciliation.service';

describe('VideoReconciliationService (integration, Postgres + MinIO + Redis)', () => {
  jest.setTimeout(60_000);

  const originalPrefix = process.env.QUEUE_PREFIX;
  const prefix = `${originalPrefix}-reconcile-${randomUUID()}`;

  let module: TestingModule;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storage: StorageService;
  let queue: Queue;
  let reconciliation: VideoReconciliationService;
  let channel: Channel;
  const createdVideos = new Map<string, string>();

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = prefix;
    // Producer side only (no consumers), so enqueued jobs stay observable
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot(configModuleOptions),
        DatabaseModule,
        UsersModule,
        VideosModule,
        StorageModule,
        VideoProcessingQueueModule,
      ],
      providers: [VideoReconciliationService],
    }).compile();
    await module.init();

    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    storage = module.get(StorageService);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    reconciliation = module.get(VideoReconciliationService);
  });

  afterAll(async () => {
    for (const [id, uploadId] of createdVideos) {
      await storage?.abortMultipartUpload(videoOriginalKey(id), uploadId);
      await storage?.deletePrefix(videoPrefix(id));
    }
    await queue?.obliterate({ force: true });
    if (dataSource) {
      await cleanAllTables(dataSource);
    }
    await module?.close();
    process.env.QUEUE_PREFIX = originalPrefix;
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
    const user = await dataSource.getRepository(User).save({
      email: 'reconcile_it@example.com',
      password: 'hashed',
    });
    channel = await dataSource.getRepository(Channel).save({
      name: 'Reconcile IT',
      nickname: 'reconcile-it',
      user_id: user.id,
    });
  });

  /** A draft with a real open multipart upload, created `hoursAgo`. */
  async function draftCreated(hoursAgo: number): Promise<Video> {
    const id = randomUUID();
    const uploadId = await storage.createMultipartUpload(
      videoOriginalKey(id),
      'video/mp4',
    );
    createdVideos.set(id, uploadId);
    await videoRepository.insert({
      id,
      channel_id: channel.id,
      slug: randomUUID().slice(0, 11),
      title: 'Draft',
      original_filename: 'draft.mp4',
      mime_type: 'video/mp4',
      declared_size: 1024,
      upload_id: uploadId,
    });
    await dataSource.query(
      `UPDATE "videos" SET "created_at" = now() - ($2 || ' minutes')::interval WHERE id = $1`,
      [id, String(Math.round(hoursAgo * 60))],
    );
    return videoRepository.findOneByOrFail({ id });
  }

  /** A video `processing` since `hoursAgo`. */
  async function processingSince(hoursAgo: number): Promise<Video> {
    const video = await draftCreated(hoursAgo + 1);
    await dataSource.query(
      `UPDATE "videos" SET "status" = 'processing', "processing_started_at" = now() - ($2 || ' minutes')::interval WHERE id = $1`,
      [video.id, String(Math.round(hoursAgo * 60))],
    );
    return video;
  }

  const reload = (id: string) => videoRepository.findOneByOrFail({ id });

  describe('abandoned drafts', () => {
    it('should fail a 25 h old draft, keep the row and abort its upload', async () => {
      const video = await draftCreated(25);

      const result = await reconciliation.run();

      expect(result.abandoned).toBe(1);
      await expect(reload(video.id)).resolves.toMatchObject({
        status: VideoStatus.Failed,
        failure_reason: 'upload_abandoned',
      });
      await expect(
        storage.listParts(videoOriginalKey(video.id), video.upload_id),
      ).resolves.toBeNull();
    });

    it('should leave a 23 h old draft untouched', async () => {
      const video = await draftCreated(23);

      const result = await reconciliation.run();

      expect(result.abandoned).toBe(0);
      await expect(reload(video.id)).resolves.toMatchObject({
        status: VideoStatus.Draft,
        failure_reason: null,
      });
      await expect(
        storage.listParts(videoOriginalKey(video.id), video.upload_id),
      ).resolves.toEqual([]);
    });

    it('should fail a draft whose upload was already aborted', async () => {
      const video = await draftCreated(25);
      await storage.abortMultipartUpload(
        videoOriginalKey(video.id),
        video.upload_id,
      );

      await reconciliation.run();

      await expect(reload(video.id)).resolves.toMatchObject({
        status: VideoStatus.Failed,
        failure_reason: 'upload_abandoned',
      });
    });

    it('should not overwrite a draft that a completion moved to processing first', async () => {
      const video = await draftCreated(25);
      const abort = storage.abortMultipartUpload.bind(storage);
      // The upload completes while the sweep is aborting
      jest
        .spyOn(storage, 'abortMultipartUpload')
        .mockImplementationOnce(async (key, uploadId) => {
          await abort(key, uploadId);
          await videoRepository.update(
            { id: video.id },
            { status: VideoStatus.Processing },
          );
        });

      const result = await reconciliation.run();

      expect(result.abandoned).toBe(0);
      await expect(reload(video.id)).resolves.toMatchObject({
        status: VideoStatus.Processing,
        failure_reason: null,
      });
    });
  });

  describe('stuck processing', () => {
    it('should enqueue a process-video job for a video processing for 2 h', async () => {
      const video = await processingSince(2);

      const result = await reconciliation.run();

      expect(result.requeued).toBe(1);
      const job = await queue.getJob(video.id);
      expect(job).toBeDefined();
      expect(job!.name).toBe(PROCESS_VIDEO_JOB);
      expect(job!.data).toEqual({ videoId: video.id });
    });

    it('should leave a video processing for 30 min alone', async () => {
      const video = await processingSince(0.5);

      const result = await reconciliation.run();

      expect(result.requeued).toBe(0);
      await expect(queue.getJob(video.id)).resolves.toBeUndefined();
    });

    it('should not duplicate a job that is still queued', async () => {
      const video = await processingSince(2);
      await reconciliation.run();
      const firstJob = await queue.getJob(video.id);

      await reconciliation.run();

      await expect(queue.getWaitingCount()).resolves.toBe(1);
      const job = await queue.getJob(video.id);
      expect(job!.timestamp).toBe(firstJob!.timestamp);
    });
  });
});
