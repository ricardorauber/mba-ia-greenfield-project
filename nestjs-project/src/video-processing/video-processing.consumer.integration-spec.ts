import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { getQueueToken } from '@nestjs/bullmq';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Job, Queue } from 'bullmq';
import { DataSource, type Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import {
  createVideoFixtures,
  type VideoFixtures,
} from '../test/video-fixtures';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { videoOriginalKey, videoPrefix } from '../videos/video-storage-keys';
import { WorkerModule } from '../worker.module';
import { VideoProcessingConsumer } from './video-processing.consumer';
import { VideoProcessingProducer } from './video-processing.producer';
import {
  VIDEO_PROCESSING_QUEUE,
  VIDEO_RECONCILIATION_QUEUE,
} from './video-processing.queue';

const SETTLE_TIMEOUT_MS = 60_000;

describe('VideoProcessingConsumer (integration, Redis + Postgres + MinIO + FFmpeg)', () => {
  jest.setTimeout(120_000);

  const originalPrefix = process.env.QUEUE_PREFIX;
  // Unique per file: the dev video-worker never sees these jobs and vice versa
  const prefix = `${originalPrefix}-consumer-${randomUUID()}`;

  let fixtures: VideoFixtures;
  let module: TestingModule;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storage: StorageService;
  let producer: VideoProcessingProducer;
  let queue: Queue;
  let channel: Channel;
  const failedAttempts = new Map<string, number>();
  const createdVideoIds: string[] = [];

  beforeAll(async () => {
    fixtures = await createVideoFixtures();
    process.env.QUEUE_PREFIX = prefix;
    // The real worker graph: no entity registration patched in by the test
    module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    await module.init();

    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    storage = module.get(StorageService);
    producer = module.get(VideoProcessingProducer);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    // removeOnFail drops the job from Redis, so record attempts on the event
    module
      .get(VideoProcessingConsumer)
      .worker.on('failed', (job: Job | undefined) => {
        if (job) {
          failedAttempts.set(job.id!, job.attemptsMade);
        }
      });
  });

  afterAll(async () => {
    await queue?.obliterate({ force: true });
    // WorkerModule also upserts the reconcile-videos scheduler on boot
    await module
      ?.get<Queue>(getQueueToken(VIDEO_RECONCILIATION_QUEUE))
      .obliterate({ force: true });
    for (const id of createdVideoIds) {
      await storage?.deletePrefix(videoPrefix(id));
    }
    if (dataSource) {
      await cleanAllTables(dataSource);
    }
    await module?.close();
    await fixtures?.cleanup();
    process.env.QUEUE_PREFIX = originalPrefix;
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save({
      email: 'consumer_it@example.com',
      password: 'hashed',
    });
    channel = await dataSource.getRepository(Channel).save({
      name: 'Consumer IT',
      nickname: 'consumer-it',
      user_id: user.id,
    });
  });

  async function enqueueProcessingVideo(file: string): Promise<string> {
    const id = randomUUID();
    createdVideoIds.push(id);
    const bytes = await readFile(file);
    await storage.putObject(videoOriginalKey(id), bytes, 'video/mp4');
    await videoRepository.insert({
      id,
      channel_id: channel.id,
      slug: randomUUID().slice(0, 11),
      title: 'Fixture',
      original_filename: 'fixture.mp4',
      mime_type: 'video/mp4',
      declared_size: bytes.length,
      upload_id: 'completed-upload',
      status: VideoStatus.Processing,
      processing_started_at: () => 'now()',
    });
    await producer.enqueue(id);
    return id;
  }

  async function waitForSettledStatus(id: string): Promise<Video> {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const video = await videoRepository.findOneByOrFail({ id });
      if (video.status !== VideoStatus.Processing) {
        return video;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(
      `Video ${id} still processing after ${SETTLE_TIMEOUT_MS} ms`,
    );
  }

  it('should take a valid video job to ready', async () => {
    const id = await enqueueProcessingVideo(fixtures.mp4);

    const video = await waitForSettledStatus(id);

    expect(video.status).toBe(VideoStatus.Ready);
    expect(video.has_thumbnail).toBe(true);
    expect(video.duration).toBeCloseTo(3, 0);
  });

  it('should fail a codec outside the allowlist after a single attempt', async () => {
    const id = await enqueueProcessingVideo(fixtures.mp4Mpeg4Part2);

    const video = await waitForSettledStatus(id);

    expect(video).toMatchObject({
      status: VideoStatus.Failed,
      failure_reason: 'unsupported_format',
      has_thumbnail: false,
    });
    expect(failedAttempts.get(id)).toBe(1);
  });
});
