import type { JobsOptions } from 'bullmq';

export const VIDEO_PROCESSING_QUEUE = 'video-processing';
export const PROCESS_VIDEO_JOB = 'process-video';

export const VIDEO_RECONCILIATION_QUEUE = 'video-reconciliation';
export const RECONCILE_JOB = 'reconcile';
export const RECONCILE_SCHEDULER_ID = 'reconcile-videos';

export interface ProcessVideoJobData {
  videoId: string;
}

// Removing finished jobs frees the `jobId` so the same video can be re-enqueued
export const PROCESS_VIDEO_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: true,
  removeOnFail: true,
} as const satisfies JobsOptions;
