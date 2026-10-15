import type { VideoFailureReason } from '../videos/entities/video.entity';

export type PermanentFailureReason = Extract<
  VideoFailureReason,
  'unsupported_format' | 'invalid_media'
>;

/** Retrying cannot help: the job must fail at once and the video becomes `failed`. */
export class PermanentProcessingError extends Error {
  constructor(
    public readonly reason: PermanentFailureReason,
    message: string = reason,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'PermanentProcessingError';
  }
}
