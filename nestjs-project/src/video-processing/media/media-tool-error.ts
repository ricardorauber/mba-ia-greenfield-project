/**
 * `invalid_media`: the input itself is broken; retrying cannot help.
 * `transient`: network, storage, timeout or anything unrecognised; worth a retry.
 */
export type MediaToolErrorKind = 'invalid_media' | 'transient';

export class MediaToolError extends Error {
  constructor(
    public readonly kind: MediaToolErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'MediaToolError';
  }
}

const INVALID_MEDIA_PATTERNS = [
  /Invalid data found when processing input/i,
  /moov atom not found/i,
  /EBML header parsing failed/i,
];

interface ProcessFailure {
  killed?: boolean;
  signal?: string | null;
  message?: string;
}

export function classifyFfmpegFailure(
  stderr: string,
  error: unknown,
): MediaToolError {
  const failure = (error ?? {}) as ProcessFailure;
  const detail = stderr.trim() || failure.message || 'unknown failure';

  // A process killed by the execFile timeout says nothing about the media
  if (failure.killed) {
    return new MediaToolError(
      'transient',
      `Media tool timed out (${failure.signal ?? 'killed'}): ${detail}`,
      { cause: error },
    );
  }

  const kind = INVALID_MEDIA_PATTERNS.some((pattern) => pattern.test(stderr))
    ? 'invalid_media'
    : 'transient';
  return new MediaToolError(kind, detail, { cause: error });
}
