---
libs:
  "@nestjs/bullmq":
    version: "12.0.0"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-10-15T14:12:01-03:00"
  bullmq:
    version: "6.3.15"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-10-15T14:12:01-03:00"
  ioredis:
    version: "6.0.0"
    context7_id: "/redis/ioredis/v6.0.0"
    fetched_at: "2026-10-15T14:12:01-03:00"
  "@aws-sdk/client-s3":
    version: "3.1152.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-15T14:12:01-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "3.1152.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-15T14:12:01-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-15T14:18:05-03:00"
---

# phase-03-videos — Library References

Distilled docs for the libraries decided in this slice, pulled through Context7 on 2026-10-15. Versions are **exact pins**, checked with `npm view` against the dev image (`node:25.6.0-slim`, Debian 12) and the installed `@nestjs/core` 11.1.16. Resolve refreshes this file when the library set in `## Decisions Index` drifts from the set cached here.

## @nestjs/bullmq

**Source:** `/nestjs/bull` (Context7), maps to `phase-03-videos/TD-01`. **Pin:** `12.0.0`, published 2026-08-27. Peer dependencies: `@nestjs/common` / `@nestjs/core` `^10 || ^11 || ^12` and `bullmq` `^3 … ^6`, so it works with Nest 11. It depends on `@nestjs/bull-shared@^12.0.0`.

### Root connection (async, from the config namespace)

```ts
import { BullModule } from '@nestjs/bullmq';

BullModule.forRootAsync({
  imports: [ConfigModule],
  inject: [queueConfig.KEY],
  useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
    connection: { host: cfg.redisHost, port: cfg.redisPort }, // host = Compose service name "redis"
  }),
});
```

Follow the phase-01 convention: a `registerAs('queue', …)` factory validated by the Joi schema, injected through `ConfigType`.

### Queue registration, producer, and consumer

- `BullModule.registerQueue({ name: 'video-processing', defaultJobOptions: { attempts, backoff } })`. Any `QueueOptions` field is accepted. On `onApplicationShutdown`, the module closes workers and then the queue (`forceDisconnectOnShutdown` is optional).
- Producer (API): `@InjectQueue('video-processing') private readonly queue: Queue`, then `queue.add(name, data, { jobId: videoId })`.
- Consumer (worker only): the class **must** extend `WorkerHost`, or Nest throws `InvalidProcessorClassError`.

```ts
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor('video-processing', { concurrency: 1 })
export class VideoProcessingConsumer extends WorkerHost {
  async process(job: Job<{ videoId: string }>): Promise<void> { /* … */ }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) { /* … */ }
}
```

- Register `@Processor` providers **only in the worker's module graph** (TD-02). The API module imports `registerQueue` for the producer only. Otherwise the API process would also consume jobs.
- The worker bootstraps with `NestFactory.createApplicationContext(WorkerModule)`, which starts no HTTP server. Call `app.enableShutdownHooks()` so that SIGTERM closes workers gracefully.

## bullmq

**Source:** `/taskforcesh/bullmq` (Context7, docs for v6.3.11), maps to `phase-03-videos/TD-01` and `TD-13`. **Pin:** `6.3.15`, published 2026-10-14 (Node `>=14.17`).

### v6 breaking changes that matter here

- **`ioredis` is no longer a direct dependency.** It is an optional peer that Redis users must install explicitly (see the `ioredis` section). The other optional peers (`pg`, `redis`, `bullmq-otel`) are not needed.
- High-level classes no longer expose Redis internals: `Queue#client`, `Worker#blockingClient` and others were removed. Use `getBackend()` instead. `Worker#waitUntilReady()` now resolves to `void`, and `Worker#resume()` is async.
- `ConnectionOptions = IORedis.RedisOptions | IORedis.Redis | …`. Plain `{ host, port }` options are enough.

### Retries and permanent errors (TD-13)

```ts
await queue.add('process', { videoId }, {
  jobId: videoId,                                  // idempotent enqueue / re-enqueue
  attempts: 5,
  backoff: { type: 'exponential', delay: 5_000 },  // 2^(attempt-1) * delay
});

import { UnrecoverableError } from 'bullmq';
throw new UnrecoverableError('UNSUPPORTED_CODEC'); // → failed immediately, attempts ignored
```

### Stalled jobs and long FFmpeg runs

- `WorkerOptions` defaults: `lockDuration` 30000 ms, `stalledInterval` 30000 ms, `maxStalledCount` 1. The worker renews the lock automatically while `process()` runs, but a blocked event loop can lose the lock. Keep FFmpeg in a child process; never run it synchronously.
- A job that stalls more than `maxStalledCount` times fails with "job stalled more than allowable limit". Map that failure to `status = failed` in an `@OnWorkerEvent('failed')` handler only when `job.attemptsMade >= job.opts.attempts`, or when the error is unrecoverable.
- Redis must use `maxmemory-policy noeviction`, or BullMQ can lose jobs.
- Workers need `maxRetriesPerRequest: null`. BullMQ sets it by default for the connections it creates; if you pass your own ioredis instance, set it yourself, or BullMQ logs a warning.

### Reconciliation sweep (TD-13): use job schedulers in v6

```ts
await queue.upsertJobScheduler(
  'reconcile-videos',            // stable scheduler id: idempotent on every boot
  { every: 5 * 60_000 },         // or { pattern: '*/5 * * * *' }
  { name: 'reconcile', data: {}, opts: { removeOnComplete: true, removeOnFail: 100 } },
);
```

`upsertJobScheduler` replaces the legacy `repeat:` option on `queue.add` (the older docs that use `QueueScheduler` predate v2 and do not apply). Deduplication options are not available on scheduler templates; the sweep's own re-enqueues rely on `jobId: videoId`.

### Testing notes

- Unit tests: call `consumer.process(fakeJob)` directly with mocked collaborators.
- Integration tests: use real Redis (the `redis` Compose service), a unique queue name or prefix per test file, and `queue.obliterate({ force: true })` plus `worker.close()` in `afterAll`. See `testing-guide-nestjs-project` → `artifacts/future-types.md` and `references/external-systems.md`.

## ioredis

**Source:** `/redis/ioredis/v6.0.0` (Context7), the required BullMQ 6 peer for `phase-03-videos/TD-01`. **Pin:** `6.0.0`.

- **Breaking changes in v6:** it requires Node ≥ 20, which `node:25.6.0-slim` satisfies, and **defaults to RESP3** (`protocol: 3`). Set `protocol: 2` to keep v5 wire behavior if a Redis-side incompatibility appears. Redis 8.x supports RESP3.
- TypeScript import: `import { Redis } from 'ioredis'`. The default import still works but is slated for deprecation.
- Useful options: `host`, `port`, `password`, `connectTimeout` (default 10000 ms), `lazyConnect`, `enableOfflineQueue`, and `maxRetriesPerRequest` (default 20; must be `null` for BullMQ workers).
- Usually no direct ioredis code is needed: pass `{ host, port }` through `BullModule.forRootAsync`, and BullMQ creates the clients.

**Compose image (TD-01 Note):** `redis:8.10.2-alpine`, started with `--maxmemory-policy noeviction`, plus a `redis-cli ping` healthcheck so that `depends_on: condition: service_healthy` works.

## @aws-sdk/client-s3

**Source:** `/aws/aws-sdk-js-v3` (Context7), maps to `phase-03-videos/TD-03`, used by TD-05/06/07/08/12/13/15. **Pin:** `3.1152.0` (Node `>=20`). Keep it in lockstep with `@aws-sdk/s3-request-presigner`.

### Client construction (MinIO + AWS)

```ts
import { S3Client } from '@aws-sdk/client-s3';

const internal = new S3Client({
  region: cfg.region,                 // e.g. 'us-east-1' (MinIO accepts any)
  endpoint: cfg.endpoint,             // S3_ENDPOINT=http://minio:9000 (unset in prod)
  forcePathStyle: cfg.forcePathStyle, // true for MinIO (v2's s3ForcePathStyle renamed)
  credentials: { accessKeyId, secretAccessKey },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
// TD-05: a second instance, identical except endpoint = S3_PUBLIC_ENDPOINT, used ONLY for browser-facing presigning.
```

**Pitfall: flexible checksums.** The SDK default `requestChecksumCalculation: 'WHEN_SUPPORTED'` adds `x-amz-sdk-checksum-algorithm` and `x-amz-checksum-crc32` to operations such as `PutObject` and `UploadPart`. In presigned URLs, those checksums would bind to a body the browser has not sent, and S3-compatible servers may reject them. Set both options to `'WHEN_REQUIRED'` on both clients (see aws-sdk-js-v3 issue #6810).

### Commands used by this slice

| Need | Command | Notes |
|------|---------|-------|
| Initiate upload (TD-07) | `CreateMultipartUploadCommand({ Bucket, Key, ContentType })` | Returns `UploadId`. Key: `videos/{videoId}/original`. |
| Resume (TD-07) | `ListPartsCommand({ Bucket, Key, UploadId })` | Paginate with `PartNumberMarker` / `IsTruncated` (at most 160 parts at 64 MiB, under the 1000-part page). |
| Complete (TD-08) | `CompleteMultipartUploadCommand({ …, MultipartUpload: { Parts: [{ PartNumber, ETag }] } })` | Parts in ascending order. Take the ETags from `ListParts`, not from the client. |
| Abort (TD-13) | `AbortMultipartUploadCommand({ Bucket, Key, UploadId })` | Used by the reconciliation sweep. `NoSuchUpload` means it is already gone, which is idempotent. |
| Size check (TD-07/08) | `HeadObjectCommand` → `ContentLength` | Compare with the declared size and the 10 GiB limit. |
| Thumbnail write (TD-11) | `PutObjectCommand({ Key: 'videos/{id}/thumbnail.jpg', Body, ContentType: 'image/jpeg' })` | Server-side, through the internal client. |
| Cleanup | `DeleteObjectCommand` / `DeleteObjectsCommand` | Per-video prefix (TD-06). |
| Bucket bootstrap | `CreateBucketCommand`, `PutBucketCorsCommand`, `PutBucketLifecycleConfigurationCommand` | Only if `/plan-build` picks SDK bootstrap over `pgsty/mc` (TD-04). CORS must `ExposeHeaders: ['ETag']` and allow `PUT`/`GET` from the frontend origin. Lifecycle: `AbortIncompleteMultipartUpload { DaysAfterInitiation }` as defense in depth. Verify that `pgsty/minio` honors that rule; if not, the sweep alone covers it. |

### Error handling

Catch `S3ServiceException` (from `@aws-sdk/client-s3`) and branch on `err.name` (`'NoSuchKey'`, `'NotFound'` for `HeadObject`, `'NoSuchUpload'`) or on `err.$metadata.httpStatusCode`. `instanceof` is safe across packages because the base class overrides `Symbol.hasInstance`. Map these errors to domain errors under `phase-02-auth/TD-07`.

## @aws-sdk/s3-request-presigner

**Source:** `/aws/aws-sdk-js-v3` → `packages/s3-request-presigner` (Context7), maps to `phase-03-videos/TD-03`, `TD-05`, `TD-07`, `TD-12` and `TD-15`. **Pin:** `3.1152.0`.

```ts
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { UploadPartCommand, GetObjectCommand } from '@aws-sdk/client-s3';

// TD-07: browser-facing part URL → sign with the PUBLIC client
const partUrl = await getSignedUrl(publicClient,
  new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }), { expiresIn: 900 });

// TD-15: stream (302 target) and download → PUBLIC client
const streamUrl = await getSignedUrl(publicClient, new GetObjectCommand({ Bucket, Key }), { expiresIn });
const downloadUrl = await getSignedUrl(publicClient, new GetObjectCommand({
  Bucket, Key, ResponseContentDisposition: `attachment; filename="${safeName}"`,
}), { expiresIn });

// TD-12: worker input for ffprobe/ffmpeg → INTERNAL client (http://minio:9000)
const sourceUrl = await getSignedUrl(internalClient, new GetObjectCommand({ Bucket, Key }), { expiresIn: 3600 });
```

- `expiresIn` defaults to 900 s. Presigning is a local HMAC computation with no network call, which is why the API can sign for `localhost:9000` (TD-05).
- `Content-Type` is **unsigned** by default; to enforce it, pass `signableHeaders`. The payload is `UNSIGNED-PAYLOAD`, so a presigned `UploadPart` URL cannot enforce `Content-Length`. Size limits are enforced through the declared size at initiation plus `HeadObject` at completion (TD-07 Note).
- `response-content-disposition` overrides work only on signed requests, which a presigned URL is.
- To force `x-amz-*` headers into the signature, use `unhoistableHeaders: new Set([...])`. That is not needed here.
- In tests inside `nestjs-api`, `S3_PUBLIC_ENDPOINT=http://minio:9000` (TD-05 Note), so presigned URLs can be exercised with real `fetch` `PUT`/`GET` calls.

## ffmpeg / ffprobe (system binaries, not npm)

**Source:** `/websites/ffmpeg_documentation` (Context7), maps to `phase-03-videos/TD-11` and `TD-12`. **Version:** Debian 12 `ffmpeg` apt package (`7:5.1.9-0+deb12u1` candidate), installed in the shared `Dockerfile.dev` (TD-02 Note). It is not tracked in `libs:` because it is not an npm package.

- **Metadata:** `ffprobe -v error -print_format json -show_format -show_streams <url>`. Read `format.format_name`, `format.duration`, `format.size` and `format.bit_rate`. Per stream, read `codec_type`, `codec_name`, `width`, `height` and `avg_frame_rate` (a fraction such as `"30000/1001"`). A non-zero exit code or empty `streams` means a permanent error, which maps to `UnrecoverableError`.
- **Thumbnail (AMB-3 rule):** `ffmpeg -v error -ss <t> -i <url> -frames:v 1 -vf "scale='min(1280,iw)':-2" -f image2 -c:v mjpeg pipe:1` (or write to a temp file). Placing `-ss` **before** `-i` makes it an input seek: ffmpeg jumps to the nearest seek point, then decodes forward. Here `t = 0.1 * duration`, or 0 when the duration is under 1 s.
- **HTTP input (TD-12):** ffmpeg's HTTP protocol issues Range requests for seekable inputs. Resilience options include `-reconnect 1`, `-reconnect_on_network_error 1`, `-reconnect_on_http_error 5xx`, `-reconnect_delay_max <s>` and `-reconnect_max_retries <n>`. Network failures should surface as retryable errors (no `UnrecoverableError`).
- **Test fixtures:** generate clips at test time with `ffmpeg -f lavfi -i testsrc=duration=3:size=320x240:rate=25 -f lavfi -i sine=frequency=440:duration=3 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest out.mp4`. For WebM, use `-c:v libvpx-vp9 -c:a libopus`. Corrupt or unsupported inputs can be built from truncated bytes or `-c:v mpeg4` in an `.avi` container.
- Invoke the binaries with `execFile`/`spawn` and an argument array (no shell), plus a timeout and stderr capture, behind an injectable service (TD-11).
