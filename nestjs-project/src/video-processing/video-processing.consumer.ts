import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { type Job, UnrecoverableError } from 'bullmq';
import {
  type VideoFailureReason,
  VideoStatus,
} from '../videos/entities/video.entity';
import { VideosService } from '../videos/videos.service';
import {
  type PermanentFailureReason,
  PermanentProcessingError,
} from './video-processing-errors';
import {
  type ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.queue';
import { VideoProcessingService } from './video-processing.service';

const PERMANENT_REASONS: readonly PermanentFailureReason[] = [
  'unsupported_format',
  'invalid_media',
];
// BullMQ's failure message for a job whose lock was lost too many times
const STALLED_LIMIT_MESSAGE = 'stalled more than allowable limit';

/**
 * Which `failure_reason` a failed attempt settles, or `null` while BullMQ
 * still retries it (TD-13).
 */
export function finalFailureReason(
  job: Pick<Job, 'attemptsMade' | 'opts'>,
  error: Error,
): VideoFailureReason | null {
  if (error instanceof UnrecoverableError) {
    return (
      PERMANENT_REASONS.find((reason) => reason === error.message) ??
      'processing_error'
    );
  }
  if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
    return 'processing_error';
  }
  if (error.message.includes(STALLED_LIMIT_MESSAGE)) {
    return 'processing_error';
  }
  return null;
}

// One FFmpeg job at a time per worker: it is CPU-bound (TD-02)
@Processor(VIDEO_PROCESSING_QUEUE, { concurrency: 1 })
export class VideoProcessingConsumer extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingConsumer.name);

  constructor(
    private readonly processingService: VideoProcessingService,
    private readonly videosService: VideosService,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    try {
      await this.processingService.process(job.data.videoId);
    } catch (err) {
      // Fails the job at once; other errors are retried with backoff
      if (err instanceof PermanentProcessingError) {
        throw new UnrecoverableError(err.reason);
      }
      throw err;
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<ProcessVideoJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) {
      return;
    }
    const reason = finalFailureReason(job, error);
    if (!reason) {
      this.logger.warn(
        `Video ${job.data.videoId} attempt ${job.attemptsMade} failed, will retry: ${error.message}`,
      );
      return;
    }

    // Event handler: rethrowing would only surface as an unhandled rejection;
    // a video left in processing is picked up again by the sweep
    try {
      await this.videosService.markFailed(
        job.data.videoId,
        reason,
        VideoStatus.Processing,
      );
      this.logger.error(
        `Video ${job.data.videoId} failed (${reason}): ${error.message}`,
      );
    } catch (markErr) {
      this.logger.error(
        `Could not mark video ${job.data.videoId} as failed: ${String(markErr)}`,
      );
    }
  }
}
