// 10 GiB (TD-07)
export const MAX_VIDEO_SIZE_BYTES = 10 * 1024 ** 3;

// 64 MiB fixed part size: at most 160 parts for the 10 GiB limit (TD-07)
export const UPLOAD_PART_SIZE_BYTES = 64 * 1024 ** 2;

// Accepted MIME type → required file extension (TD-09)
export const ALLOWED_VIDEO_TYPES: Readonly<Record<string, string>> = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
};

export const MAX_VIDEO_TITLE_LENGTH = 100;
