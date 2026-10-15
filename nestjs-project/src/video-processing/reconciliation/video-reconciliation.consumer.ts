import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { VIDEO_RECONCILIATION_QUEUE } from '../video-processing.queue';
import {
  type ReconciliationResult,
  VideoReconciliationService,
} from './video-reconciliation.service';

// Own queue so a sweep never waits behind long FFmpeg jobs (TD-13)
@Processor(VIDEO_RECONCILIATION_QUEUE, { concurrency: 1 })
export class VideoReconciliationConsumer extends WorkerHost {
  private readonly logger = new Logger(VideoReconciliationConsumer.name);

  constructor(
    private readonly reconciliationService: VideoReconciliationService,
  ) {
    super();
  }

  async process(): Promise<ReconciliationResult> {
    const result = await this.reconciliationService.run();
    this.logger.log(
      `Reconciliation run: ${result.abandoned} abandoned draft(s) failed, ${result.requeued} stuck video(s) re-enqueued`,
    );
    return result;
  }
}
