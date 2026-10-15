import { randomUUID } from 'crypto';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import queueConfig from '../../config/queue.config';
import { QueueModule } from '../../queue/queue.module';
import {
  RECONCILE_JOB,
  RECONCILE_SCHEDULER_ID,
  VIDEO_RECONCILIATION_QUEUE,
} from '../video-processing.queue';
import { VideoReconciliationScheduler } from './video-reconciliation.scheduler';

describe('VideoReconciliationScheduler (integration, Redis)', () => {
  jest.setTimeout(30_000);

  const originalPrefix = process.env.QUEUE_PREFIX;
  const prefix = `${originalPrefix}-scheduler-${randomUUID()}`;

  beforeAll(() => {
    process.env.QUEUE_PREFIX = prefix;
  });

  afterAll(() => {
    process.env.QUEUE_PREFIX = originalPrefix;
  });

  // One worker boot: compile, run onApplicationBootstrap, return the queue
  async function bootstrap() {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
        BullModule.registerQueue({ name: VIDEO_RECONCILIATION_QUEUE }),
      ],
      providers: [VideoReconciliationScheduler],
    }).compile();
    await module.init();
    return {
      module,
      queue: module.get<Queue>(getQueueToken(VIDEO_RECONCILIATION_QUEUE)),
    };
  }

  it('should leave exactly one reconcile-videos scheduler every 15 min after two boots', async () => {
    const first = await bootstrap();
    await first.module.close();
    const second = await bootstrap();

    try {
      const schedulers = await second.queue.getJobSchedulers();

      expect(schedulers).toHaveLength(1);
      expect(schedulers[0]).toMatchObject({
        key: RECONCILE_SCHEDULER_ID,
        name: RECONCILE_JOB,
        every: 900000,
      });
    } finally {
      await second.queue.obliterate({ force: true });
      await second.module.close();
    }
  });
});
