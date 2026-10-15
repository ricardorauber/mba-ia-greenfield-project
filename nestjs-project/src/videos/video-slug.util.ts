import { randomBytes } from 'crypto';

/** 64 random bits encoded as 11 base64url characters (TD-14). */
export function generateVideoSlug(): string {
  return randomBytes(8).toString('base64url');
}
