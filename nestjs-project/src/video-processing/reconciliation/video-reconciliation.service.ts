import { Injectable, Logger } from '@nestjs/common';
import { StorageService } from '../../storage/storage.service';
import { VideoStatus } from '../../videos/entities/video.entity';
import { videoOriginalKey } from '../../videos/video-storage-keys';
import { VideosService } from '../../videos/videos.service';
import { VideoProcessingProducer } from '../video-processing.producer';
import {
  ABANDONED_DRAFT_AFTER_MS,
  RECONCILE_BATCH_LIMIT,
  STUCK_PROCESSING_AFTER_MS,
} from './reconciliation.constants';

export interface ReconciliationResult {
  abandoned: number;
  requeued: number;
}

/**
 * Periodic safety net for the async pipeline (TD-13): fails drafts nobody
 * finished uploading and re-enqueues videos whose processing job got lost.
 * Every action is idempotent, so overlapping or repeated runs are harmless.
 */
@Injectable()
export class VideoReconciliationService {
  private readonly logger = new Logger(VideoReconciliationService.name);

  constructor(
    private readonly videosService: VideosService,
    private readonly storageService: StorageService,
    private readonly processingProducer: VideoProcessingProducer,
  ) {}

  async run(now: Date = new Date()): Promise<ReconciliationResult> {
    return {
      abandoned: await this.failAbandonedDrafts(now),
      requeued: await this.requeueStuckProcessing(now),
    };
  }

  private async failAbandonedDrafts(now: Date): Promise<number> {
    const drafts = await this.videosService.findAbandonedDrafts(
      new Date(now.getTime() - ABANDONED_DRAFT_AFTER_MS),
      RECONCILE_BATCH_LIMIT,
    );

    let abandoned = 0;
    for (const draft of drafts) {
      try {
        // Already-aborted uploads (NoSuchUpload) count as aborted
        await this.storageService.abortMultipartUpload(
          videoOriginalKey(draft.id),
          draft.upload_id,
        );
      } catch (err) {
        // Background task: keep the draft for the next run, go on with the rest
        this.logger.warn(
          `Could not abort the upload of abandoned video ${draft.id}: ${String(err)}`,
        );
        continue;
      }
      // Conditional: an upload completed meanwhile keeps its processing status
      if (
        await this.videosService.markFailed(
          draft.id,
          'upload_abandoned',
          VideoStatus.Draft,
        )
      ) {
        abandoned++;
      }
    }
    return abandoned;
  }

  private async requeueStuckProcessing(now: Date): Promise<number> {
    const stuck = await this.videosService.findStuckProcessing(
      new Date(now.getTime() - STUCK_PROCESSING_AFTER_MS),
      RECONCILE_BATCH_LIMIT,
    );
    // jobId = videoId: a job still queued or running is not duplicated
    for (const video of stuck) {
      await this.processingProducer.enqueue(video.id);
    }
    return stuck.length;
  }
}
