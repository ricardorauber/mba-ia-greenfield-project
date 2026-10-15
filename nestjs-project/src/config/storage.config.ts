import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => {
  // Unset on AWS: the SDK resolves the regional endpoint itself
  const endpoint = process.env.S3_ENDPOINT || undefined;

  return {
    endpoint,
    // Host reachable by the client (browser); presigned URLs are signed for it
    publicEndpoint: process.env.S3_PUBLIC_ENDPOINT || endpoint,
    region: process.env.S3_REGION || 'us-east-1',
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    bucket: process.env.S3_BUCKET || 'streamtube-videos',
    forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') === 'true',
    uploadPartUrlTtlSeconds: parseInt(
      process.env.S3_UPLOAD_PART_URL_TTL_SECONDS || '3600',
      10,
    ),
    deliveryUrlTtlSeconds: parseInt(
      process.env.S3_DELIVERY_URL_TTL_SECONDS || '14400',
      10,
    ),
  };
});
