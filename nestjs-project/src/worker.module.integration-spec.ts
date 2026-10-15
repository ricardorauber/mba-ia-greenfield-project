import { randomUUID } from 'crypto';
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Queue } from 'bullmq';
import { VideoProcessingConsumer } from './video-processing/video-processing.consumer';
import {
  VIDEO_PROCESSING_QUEUE,
  VIDEO_RECONCILIATION_QUEUE,
} from './video-processing/video-processing.queue';
import { WorkerModule } from './worker.module';

describe('WorkerModule (integration)', () => {
  jest.setTimeout(60_000);

  const originalPrefix = process.env.QUEUE_PREFIX;
  const prefix = `${originalPrefix}-worker-${randomUUID()}`;
  let app: INestApplicationContext;
  let queue: Queue;

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = prefix;
    // Same bootstrap as src/worker.ts
    app = await NestFactory.createApplicationContext(WorkerModule, {
      logger: false,
    });
    queue = app.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    await app.get(VideoProcessingConsumer).worker.waitUntilReady();
  });

  afterAll(() => {
    process.env.QUEUE_PREFIX = originalPrefix;
  });

  it('should start without an HTTP server', () => {
    expect('getHttpServer' in app).toBe(false);
    expect('listen' in app).toBe(false);
  });

  it('should register exactly one running worker for video-processing', async () => {
    const worker = app.get(VideoProcessingConsumer).worker;

    expect(worker.name).toBe(VIDEO_PROCESSING_QUEUE);
    expect(worker.isRunning()).toBe(true);
    await expect(queue.getWorkersCount()).resolves.toBe(1);
  });

  it('should close the worker and its connections cleanly', async () => {
    const worker = app.get(VideoProcessingConsumer).worker;
    await queue.obliterate({ force: true });
    await app
      .get<Queue>(getQueueToken(VIDEO_RECONCILIATION_QUEUE))
      .obliterate({ force: true });

    await app.close();

    expect(worker.isRunning()).toBe(false);
  });
});
