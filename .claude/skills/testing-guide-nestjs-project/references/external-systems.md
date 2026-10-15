> Part of the `testing-guide-nestjs-project` skill (see `../SKILL.md`).

# External System Strategies

How each external system is handled in tests. These strategies were confirmed with the team.

---

## PostgreSQL — Real (Docker)

**Strategy:** Real database via the Docker `db` service (already in `compose.yaml`).

**Connection config for tests:**
```typescript
{
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME ?? 'streamtube',
  password: process.env.DB_PASSWORD ?? 'streamtube',
  database: process.env.DB_DATABASE ?? 'streamtube',
  synchronize: true, // auto-create tables in test setup
}
```

**Test isolation:**
- Use `dataSource.query('DELETE FROM "table_name"')` to clean tables between tests
- Do NOT use `repository.delete({})` — throws `Empty criteria(s) are not allowed`
- Alternative: `repository.clear()` (truncates the table)
- For complex foreign key chains, delete in reverse dependency order or use `TRUNCATE ... CASCADE`
- Use `beforeEach` for cleanup to ensure each test starts with a clean state

**Entity setup:**
- Use `synchronize: true` in test DataSource to auto-create tables from entities
- For integration tests, import only the entities needed by the test — not all entities
- For E2E tests, import `AppModule` which includes all entities via their domain modules

---

## Object Storage — Real (MinIO in Docker)

**Strategy:** Real S3-compatible storage. The `minio` Compose service in dev and tests, AWS S3 in production. No filesystem adapter and no SDK mocks: presigned URLs, multipart uploads and `Range` reads are only meaningful against a real S3 API.

**Approach:**
- The bucket (`S3_BUCKET`, `streamtube-videos`) is created by the one-shot `minio-init` service on `docker compose up`; tests never create or delete buckets.
- `src/test/setup-test-env.ts` sets `S3_PUBLIC_ENDPOINT=http://minio:9000` before `.env` loads, so presigned URLs are signed for a host reachable from inside the `nestjs-api` container. Exercise them with `fetch` (`PUT` parts, `GET` with `Range`).
- Presigned URLs are signed for one HTTP method: a `GET` URL answers `HEAD` with `403`. Read headers with a ranged `GET` (`Range: bytes=0-0`).
- Cleanup is per video prefix: `StorageService.deletePrefix(videoPrefix(id))` for every video the test created, plus `abortMultipartUpload` for uploads it left open (it is idempotent). Track `id → upload_id` when the video is created — `cleanAllTables` in `beforeEach` wipes the rows before `afterAll` runs.
- Test media is generated at test time with FFmpeg by `createVideoFixtures()` (`src/test/video-fixtures.ts`); call the returned `cleanup()` in `afterAll`.

**Setup pattern:**
```typescript
// Integration: the real StorageModule with the shared, validated config
const module = await Test.createTestingModule({
  imports: [ConfigModule.forRoot(configModuleOptions), StorageModule],
}).compile();
const storage = module.get(StorageService);
```

**Integration test:**
```typescript
describe('StorageService (integration, MinIO)', () => {
  const prefix = `storage-it/${randomUUID()}/`;

  afterAll(async () => {
    await storage.deletePrefix(prefix);
    await module.close();
  });

  it('should accept a PUT on a presigned part URL', async () => {
    const key = `${prefix}original`;
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const { url } = await storage.presignUploadPart(key, uploadId, 1);

    const res = await fetch(url, { method: 'PUT', body: new Uint8Array(bytes) });

    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBeTruthy();
  });
});
```

---

## Message Queue — Real (BullMQ on Redis in Docker)

**Strategy:** Real Redis (`redis` Compose service) with BullMQ through `@nestjs/bullmq`. Producers and consumers are tested against Redis; consumers also run the real processing (FFmpeg, MinIO, PostgreSQL) in integration and E2E tests.

**Isolation:**
- `src/test/setup-test-env.ts` sets `QUEUE_PREFIX=streamtube-test`, so no test touches the dev queues (prefix `streamtube`) — the dev `video-worker` can keep running during the suite.
- A file that starts its own workers or schedulers (anything compiling `WorkerModule`) uses a unique prefix per file before compiling, and restores it afterwards:
  `` process.env.QUEUE_PREFIX = `${originalPrefix}-<name>-${randomUUID()}` ``
- `queue.obliterate({ force: true })` every queue the file used in `afterAll` (and in `beforeEach` when tests count jobs). `WorkerModule` also upserts the `reconcile-videos` scheduler on boot, so obliterate `video-reconciliation` too.
- To observe enqueued jobs, compile only the producer side (`VideoProcessingQueueModule`, no consumers); a consumer in the same module would process the job before the assertion.
- `@nestjs/bullmq` and `@nestjs/bull-shared` are ESM-only: both Jest configs let ts-jest transform them (`transformIgnorePatterns`).

**Setup pattern:**
```typescript
// Producer side: the real queue module with the shared config
process.env.QUEUE_PREFIX = prefix;
const module = await Test.createTestingModule({
  imports: [ConfigModule.forRoot(configModuleOptions), VideoProcessingQueueModule],
}).compile();
await module.init();
const queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
```

**Producer test:**
```typescript
it('should create a waiting process-video job keyed by the video id', async () => {
  await producer.enqueue(videoId);

  const job = await queue.getJob(videoId);
  expect(job!.name).toBe(PROCESS_VIDEO_JOB);
  expect(job!.data).toEqual({ videoId });
  await expect(job!.getState()).resolves.toBe('waiting');
});
```

**Consumer test:** compile the real `WorkerModule` (unique prefix), enqueue through the producer and poll the database row until it leaves `processing`. Jobs use `removeOnFail`, so read `attemptsMade` from the worker's `failed` event (`consumer.worker.on('failed', …)`) rather than from Redis.

---

## Email — Mailpit (Real SMTP Capture)

**Strategy:** Mailpit — a local SMTP server that captures all emails for inspection via its API. No emails are actually delivered.

**Setup:**
- Add Mailpit to `compose.yaml`:
```yaml
mailpit:
  image: axllent/mailpit
  ports:
    - "1025:1025"   # SMTP
    - "8025:8025"   # Web UI / API
```

**NestJS configuration:**
```typescript
// In mail module or config
{
  transport: {
    host: process.env.SMTP_HOST ?? 'localhost',
    port: Number(process.env.SMTP_PORT ?? 1025),
  },
}
```

**Integration test:**
```typescript
describe('MailService (integration)', () => {
  beforeEach(async () => {
    // Clear all captured emails via Mailpit API
    await fetch('http://localhost:8025/api/v1/messages', { method: 'DELETE' });
  });

  it('should send confirmation email', async () => {
    await mailService.sendConfirmation('user@test.com', 'token-123');

    // Query Mailpit API for captured emails
    const response = await fetch('http://localhost:8025/api/v1/messages');
    const data = await response.json();

    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].To[0].Address).toBe('user@test.com');
    expect(data.messages[0].Subject).toContain('confirm');
  });
});
```

**Key points:**
- Mailpit captures ALL emails — no mocking, no side effects
- Use Mailpit's REST API (`http://localhost:8025/api/v1/messages`) to inspect sent emails
- Clear captured emails in `beforeEach` to ensure test isolation
- Web UI at `http://localhost:8025` for manual debugging
- Tests the full SMTP transport path — if the SMTP config is wrong, the test fails
