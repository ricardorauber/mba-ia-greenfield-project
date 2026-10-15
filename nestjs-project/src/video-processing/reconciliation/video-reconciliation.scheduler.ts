import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  RECONCILE_JOB,
  RECONCILE_SCHEDULER_ID,
  VIDEO_RECONCILIATION_QUEUE,
} from '../video-processing.queue';
import { RECONCILE_EVERY_MS } from './reconciliation.constants';

/** Registers the periodic sweep; the stable id makes every boot an upsert. */
@Injectable()
export class VideoReconciliationScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(VIDEO_RECONCILIATION_QUEUE)
    private readonly queue: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      RECONCILE_SCHEDULER_ID,
      { every: RECONCILE_EVERY_MS },
      {
        name: RECONCILE_JOB,
        data: {},
        opts: { removeOnComplete: true, removeOnFail: 100 },
      },
    );
  }
}
