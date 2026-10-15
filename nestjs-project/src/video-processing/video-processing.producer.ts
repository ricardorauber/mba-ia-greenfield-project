import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  PROCESS_VIDEO_JOB,
  PROCESS_VIDEO_JOB_OPTIONS,
  type ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.queue';

@Injectable()
export class VideoProcessingProducer {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue<ProcessVideoJobData>,
  ) {}

  /** Idempotent while the job exists: `jobId = videoId` makes BullMQ ignore duplicates. */
  async enqueue(videoId: string): Promise<void> {
    await this.queue.add(
      PROCESS_VIDEO_JOB,
      { videoId },
      { ...PROCESS_VIDEO_JOB_OPTIONS, jobId: videoId },
    );
  }
}
