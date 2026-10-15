import { randomUUID } from 'crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { configModuleOptions } from '../config/config-module.options';
import { VideoProcessingQueueModule } from './video-processing-queue.module';
import { VideoProcessingProducer } from './video-processing.producer';
import {
  PROCESS_VIDEO_JOB,
  type ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.queue';

describe('VideoProcessingProducer (integration, Redis)', () => {
  const originalPrefix = process.env.QUEUE_PREFIX;
  // Unique per file so parallel runs and leftover keys never collide
  const prefix = `${originalPrefix}-producer-${randomUUID()}`;

  let module: TestingModule;
  let producer: VideoProcessingProducer;
  let queue: Queue<ProcessVideoJobData>;

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = prefix;
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot(configModuleOptions),
        VideoProcessingQueueModule,
      ],
    }).compile();
    await module.init();

    producer = module.get(VideoProcessingProducer);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterEach(async () => {
    await queue.drain();
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await module.close();
    process.env.QUEUE_PREFIX = originalPrefix;
  });

  it('should create a waiting process-video job keyed by the video id', async () => {
    const videoId = randomUUID();

    await producer.enqueue(videoId);

    const job = await queue.getJob(videoId);
    expect(job).toBeDefined();
    expect(job!.name).toBe(PROCESS_VIDEO_JOB);
    expect(job!.data).toEqual({ videoId });
    expect(job!.opts.attempts).toBe(5);
    expect(job!.opts.backoff).toEqual({ type: 'exponential', delay: 5000 });
    await expect(job!.getState()).resolves.toBe('waiting');
  });

  it('should not duplicate the job when the same video is enqueued again', async () => {
    const videoId = randomUUID();

    await producer.enqueue(videoId);
    await producer.enqueue(videoId);

    await expect(queue.getWaitingCount()).resolves.toBe(1);
  });

  it('should create a new job once the previous one was removed', async () => {
    const videoId = randomUUID();
    await producer.enqueue(videoId);
    const first = await queue.getJob(videoId);
    await first!.remove();
    await expect(queue.getJob(videoId)).resolves.toBeUndefined();

    await producer.enqueue(videoId);

    const second = await queue.getJob(videoId);
    expect(second).toBeDefined();
    expect(second!.data).toEqual({ videoId });
    await expect(queue.getWaitingCount()).resolves.toBe(1);
  });

  it('should store the queue keys under the configured prefix', async () => {
    const videoId = randomUUID();
    await producer.enqueue(videoId);
    const redis = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT),
    });

    try {
      const keys = await redis.keys(`${prefix}:${VIDEO_PROCESSING_QUEUE}:*`);

      expect(keys).toContain(`${prefix}:${VIDEO_PROCESSING_QUEUE}:${videoId}`);
    } finally {
      await redis.quit();
    }
  });
});
