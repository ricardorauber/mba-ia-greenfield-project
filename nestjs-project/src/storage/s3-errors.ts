import { S3ServiceException } from '@aws-sdk/client-s3';

export function isS3Error(err: unknown, ...names: string[]): boolean {
  return err instanceof S3ServiceException && names.includes(err.name);
}
