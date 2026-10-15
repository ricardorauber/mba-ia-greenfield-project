// S3 client signing against the Compose-internal endpoint (server-side I/O)
export const S3_INTERNAL_CLIENT = Symbol('S3_INTERNAL_CLIENT');

// S3 client signing against the endpoint the browser can reach
export const S3_PUBLIC_CLIENT = Symbol('S3_PUBLIC_CLIENT');

export const S3_ERROR_NAMES = {
  NO_SUCH_UPLOAD: 'NoSuchUpload',
  NO_SUCH_KEY: 'NoSuchKey',
  NOT_FOUND: 'NotFound',
  ENTITY_TOO_SMALL: 'EntityTooSmall',
} as const;

export const INTERNAL_GET_URL_TTL_SECONDS = 3600;
