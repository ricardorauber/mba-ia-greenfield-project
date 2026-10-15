// Runs before `dotenv/config`: dotenv never overrides variables already set,
// so these values win over the dev `.env`.

// Keeps test jobs out of the dev queues on the shared Redis
process.env.QUEUE_PREFIX = 'streamtube-test';

// Tests run inside `nestjs-api`, where `localhost:9000` is not MinIO; presigned
// URLs must be signed for a host the test process can actually reach.
process.env.S3_PUBLIC_ENDPOINT = 'http://minio:9000';
