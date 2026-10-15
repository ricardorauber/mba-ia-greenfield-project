# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 14/20 completed

### SI-03.1 — Infra: dependências, FFmpeg na imagem e serviços Compose (minio, minio-init, redis)
- **Status:** completed
- **Tests:** no tests (Infra) — existing suites still green: 144 unit/integration (23 suites), 52 e2e (3 suites)
- **Observations:**
  - **Plan deviation (peer conflict):** `npm install --save-exact ... ioredis@6.0.0` failed with ERESOLVE because `typeorm@0.3.28` declares `peerOptional ioredis@^5.0.4` (used only by TypeORM's Redis query cache, which the project does not use). Resolved by adding a scoped `"overrides": { "typeorm": { "ioredis": "6.0.0" } }` to `package.json`, keeping every pin from TD-01. `npm ls ioredis` shows a single deduped `ioredis@6.0.0`. Alternatives rejected: downgrading to `ioredis@5.x` (breaks the TD-01 pin) or `--legacy-peer-deps` (every future install would need the flag). Remove the override once TypeORM widens its peer range.
  - MinIO healthcheck uses `curl -f http://localhost:9000/minio/health/live`; confirmed that `curl` (8.11.0) ships in `pgsty/minio:RELEASE.2026-08-04T00-00-00Z`.
  - `minio-init` gets `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and `S3_BUCKET` through `environment:` (interpolated from `.env` by Compose), so the plan's `$$VAR` entrypoint can see them inside the container.
  - The image's base is Debian 12.13; FFmpeg/ffprobe resolve to `5.1.9-0+deb12u1`.
  - `npm install` reports 51 audit vulnerabilities (2 low, 17 moderate, 29 high, 3 critical). This SI did not check how many of them predate it; running `npm audit` triage is a separate task.

### SI-03.2 — Namespaces de configuração `storage` e `queue` e ambiente de teste isolado
- **Status:** completed
- **Tests:** 24 passing (`env.validation.integration-spec.ts` + `storage.config.spec.ts`); existing e2e suite still green (52)
- **Observations:**
  - **Plan path fix:** the plan gave `<rootDir>/src/test/setup-test-env.ts` for `test/jest-e2e.json`, but that config's `rootDir: "."` resolves relative to the config file (`test/`), so Jest failed with "Module ... in the setupFiles option was not found". Used `<rootDir>/../src/test/setup-test-env.ts`. Confirmed with a throwaway e2e probe (deleted afterwards) that `QUEUE_PREFIX=streamtube-test` and `S3_PUBLIC_ENDPOINT=http://minio:9000` hold under the e2e config.
  - Added a `Jest test environment isolation` case to `env.validation.integration-spec.ts` so the AC "inside Jest, QUEUE_PREFIX/S3_PUBLIC_ENDPOINT are overridden" is observable in the unit/integration run.
  - Extra validation cases beyond the plan's list: TTL above the 7-day SigV4 cap, non-URI `S3_ENDPOINT`, out-of-range `REDIS_PORT`.

### SI-03.3 — DatabaseModule e opções de ConfigModule compartilhadas entre API e worker
- **Status:** completed
- **Tests:** 2 passing (`database.module.integration-spec.ts`); regressions green: `src/auth` 73 (6 suites), e2e 52 (3 suites, incl. `GET /`)
- **Observations:**
  - **Pre-existing flake (out of scope):** on the first, cold run of `src/auth`, `auth.service.integration-spec.ts` timed out in `beforeAll` (`createAuthTestModule()` > Jest's 5000 ms default), and `afterAll` then crashed on `dataSource.destroy()` because `dataSource` was never assigned. It passed on an unchanged re-run. That suite builds its own `ConfigModule`/`TypeOrmModule` and doesn't import anything this SI touched. Separate task: give its `beforeAll` a longer timeout and guard `afterAll` with `dataSource?.destroy()`.

### SI-03.4 — StorageModule: clientes S3 interno/público, multipart e URLs pré-assinadas
- **Status:** completed
- **Tests:** 14 passing (`storage.module.spec.ts` 3, `storage.service.integration-spec.ts` 11 against real MinIO)
- **Observations:**
  - `presignUploadPart`/`presignGet` return `{ url, expiresIn }`; `presignInternalGet` returns a plain `string`, because SI-03.15 passes it straight to ffprobe/ffmpeg as input.
  - `completeMultipartUpload` sorts the parts ascending itself and accepts `Pick<UploadedPart, 'partNumber' | 'etag'>[]`, so callers can pass the `listParts` result directly.
  - `StorageService` implements `OnModuleDestroy` and calls `destroy()` on both `S3Client`s to release sockets (no open-handle warnings in Jest).
  - The `StorageModule` unit spec proves the two clients have different endpoints by presigning with each one (a local signature, no network) and comparing the URL origins. Inside Jest the setup file makes `S3_ENDPOINT` and `S3_PUBLIC_ENDPOINT` both `http://minio:9000`, so the spec sets its own two fake hosts.
  - **Testing-guide drift (covered by SI-03.20):** `testing-guide-nestjs-project/references/external-systems.md` still prescribes a local-filesystem storage adapter for tests; this phase follows the plan (real MinIO per TD-04/TD-05).

### SI-03.5 — QueueModule e fila `video-processing` (contratos + producer)
- **Status:** completed
- **Tests:** 4 passing (`video-processing.producer.integration-spec.ts`, real Redis); fix loop 1/3. Full suites re-run after the Jest config change: 184 unit/integration (28 suites), 52 e2e (3 suites).
- **Observations:**
  - **ESM-only package (fix attempt 1):** `@nestjs/bullmq@12.0.0` and its dependency `@nestjs/bull-shared@12.0.0` ship as `"type": "module"`. The real runtime is unaffected: Node 25 `require()`s them fine, and `tsc` passes. But Jest (CommonJS through ts-jest) doesn't transform `node_modules`, so it failed with `SyntaxError: Unexpected token 'export'`. Fixed in both `package.json` (jest) and `test/jest-e2e.json`: `transformIgnorePatterns` now lets those two packages through, and a dedicated transform runs them through ts-jest with an inline `{ allowJs: true }` (ts-jest merges inline options over `tsconfig.json`). Downgrading to the CommonJS 11.x line was rejected because it would break the TD-01 pin. No e2e test imports `@nestjs/bullmq` yet; that config is first used in SI-03.12.
  - `prefix` is still a top-level `QueueOptions` field in BullMQ 6 (via `KeyPrefixOptions`), so `BullModule.forRootAsync` passes `{ connection, prefix }` as planned.
  - `PROCESS_VIDEO_JOB_OPTIONS` uses `as const satisfies JobsOptions`, so the options are type-checked against BullMQ while staying literal.
  - The producer test uses a unique prefix per file (`${QUEUE_PREFIX}-producer-<uuid>`, i.e. `streamtube-test-producer-…`), drains the queue after each test, obliterates it in `afterAll`, and scans Redis keys to cover the "keys under the configured prefix" acceptance criterion. Leftover keys after the run: 0.
  - Node prints `Warning: --localstorage-file was provided without a valid path` on every Jest run. It's a Node 25 runtime warning, not from this SI; investigating it is a separate task.

### SI-03.6 — Entidade `Video` e migration `CreateVideos`
- **Status:** completed
- **Tests:** 10 passing (`video.entity.integration-spec.ts` 7, `migrations.integration-spec.ts` 3); e2e regression 52 passing with a pre-seeded video row (cleanup respects the FK)
- **Observations:**
  - Migration generated by the CLI as `1792087643500-CreateVideos.ts`; its SQL was kept as generated and only Prettier-formatted, matching the two existing migrations. CLI `migration:run` → `migration:revert` (removes `videos` + `videos_status_enum`) → `migration:run` all checked against the dev DB, and a follow-up `migration:generate` reported "No changes in database schema", so the entity and migration have no drift. The dev DB is left at 3 applied migrations.
  - **Rule vs plan conflict:** `.claude/rules/nestjs-entities.md` says "Always define both sides of a relationship", but the Data Model says explicitly not to add the inverse `@OneToMany` on `Channel` in this phase. I followed the plan; adding `Channel.videos` is left for a later phase.
  - The Data Model lists `declared_size` as "> 0, ≤ 10737418240", but the plan's migration review list has no CHECK constraint, so none was added. Those limits are enforced at the API (DTO/service, SI-03.8). A DB-level CHECK would be a separate task.
  - **Fresh-DB caveat:** `cleanAllTables` now runs `DELETE FROM "videos"` unconditionally (as planned). Suites that build a `synchronize: true` DataSource *without* `Video` (e.g. `channel.entity.integration-spec.ts`) rely on the `videos` table already existing, which holds whenever migrations have run, but not on a brand-new empty DB. Same pre-existing assumption as the other tables; making the helper skip tables that don't exist yet is a separate task if CI ever starts from an empty DB.
  - The added test "should create the videos status enum type" asserts on `pg_type` directly so the AC "creates the table and the enum" is covered explicitly.
  - **Post-completion bugfix (approved by the maestro after the SI-03.8 escalation, committed separately):** `migrations.integration-spec.ts` dropped `MANAGED_TABLES` + `migrations` in parallel (`Promise.all`). Once `videos` (FK → `channels`) was added, the concurrent `DROP ... CASCADE`s could deadlock in Postgres. The full run then left the shared DB half-dropped, and 14 suites failed. `beforeAll` now issues a single `DROP TABLE IF EXISTS "users", "channels", "refresh_tokens", "verification_tokens", "videos", "migrations" CASCADE`, followed by a single `DROP TYPE IF EXISTS "public"."verification_tokens_type_enum", "public"."videos_status_enum" CASCADE`. Verified: the file passed 3/3 on two runs in a row; then the full `npm test -- --runInBand` passed 229/229 (35 suites); the dev DB ends with all 3 migrations applied; lint and `tsc` are clean.

### SI-03.7 — VideosService: pré-cadastro com slug único, leitura do dono e transições condicionais
- **Status:** completed
- **Tests:** 27 passing across 6 suites (`video-slug.util.spec`, `videos.service.spec`, `videos.service.integration-spec`, `channels.service.integration-spec` incl. new `findByUserId` cases, `channels.service.spec` regression for the extracted helper, `videos.module.spec`); e2e 52 passing after registering `VideosModule` in `AppModule`
- **Observations:**
  - `createDraft` uses `repository.insert` (not `save`): the id is generated by the application, so `save` would first issue a `SELECT` to decide between insert and update. It then returns `findOneByOrFail` so callers get the DB defaults (`status`, timestamps). After 5 slug collisions it throws a plain `Error`, mirroring `ChannelsService`'s nickname retry. The catalog has no domain code for this case, so it surfaces as a 500.
  - `markProcessing` sets `processing_started_at = now()` in SQL rather than `new Date()`, so it uses the same clock as `created_at` (DB default); the sweep thresholds compare against both.
  - The four transitions share one private `transition(id, expected, changes)` doing `UPDATE ... WHERE id AND status = expected` and returning `affected === 1`.
  - `isPgUniqueViolationOnColumn` still matches by `detail.includes(column)`, unchanged as the plan requires. That substring check could also match a *value* that happens to contain the column name (e.g. a nickname containing "slug"); tightening it to `Key (<column>)=` would be a separate task.

### SI-03.8 — Endpoint POST /videos (início do upload + pré-cadastro do rascunho)
- **Status:** completed
- **Tests:** `video-uploads.service.spec.ts` 17 + `video-uploads.service.integration-spec.ts` 1 + `videos.module.spec.ts` 1; e2e `test/videos-create.e2e-spec.ts` 7 (spec-derived from `specs/videos-create.plan.md`); full e2e 59 passing (4 suites); full unit/integration 226 passing excluding `migrations.integration-spec.ts` (see escalation below); fix loop 1/3; 0 leftover multipart uploads in MinIO
- **Observations:**
  - **ESCALATION — SI-03.6 regression in `src/database/migrations.integration-spec.ts`:** its `beforeAll` drops `MANAGED_TABLES` in parallel (`Promise.all` of `DROP TABLE ... CASCADE`). Since SI-03.6 added `videos` (FK → `channels`), dropping `channels CASCADE` and `videos` concurrently can hit Postgres `deadlock detected` (a timing race; it passed when run alone in SI-03.6 and SI-03.8). In the full `npm test` run it deadlocked. `afterAll` then couldn't re-apply the migrations, so the shared DB was left with only a stray `channels` table and an empty `migrations` table, and 14 later suites failed on missing tables. The dev DB was restored manually (dropped the stray `channels` with one auth-fixture row and both enum types, then `npm run migration:run` → 3 migrations). Not fixed here, because the skill says not to edit a completed SI quietly. **Resolved afterwards:** the maestro approved the single-statement `DROP TABLE` fix, recorded under SI-03.6.
  - **`test:e2e` lacked `--runInBand`:** `nestjs-project/CLAUDE.md` says e2e "always with --runInBand … already configured", but the script was `jest --config ./test/jest-e2e.json`. With the new `videos-create` suite (which wipes shared tables) running in parallel with `auth`, all 4 e2e suites failed. Added `--runInBand` to the script (one flag, matching the documented convention); `npm run test:e2e` → 59/59.
  - **Latent module-graph gap (affects SI-03.16):** `ChannelsModule` registers only `Channel`, whose `user` relation needs `User` metadata; with `autoLoadEntities`, `User` is only registered by `UsersModule` (which itself imports `ChannelsModule`, so the reverse import would be circular). Inside `AppModule` it works; a graph of `DatabaseModule` + `VideosModule` alone fails with `Entity metadata for Channel#user was not found`. The integration test adds `TypeOrmModule.forFeature([User])` to mirror `AppModule` (fix attempt 1). The worker graph in SI-03.16 will hit the same error and needs a decision there.
  - `createAuthenticatedUser(app, email?)` returns `{ userId, email, access_token }` (superset of the plan's "returns `access_token`"): later specs need two distinct users per test and the owner's channel. It generates a unique email and reads `userId` from the JWT `sub`. It makes 3 auth requests against the global 10/min throttler, so every video e2e suite must `throttlerStorage.storage.clear()` in `beforeEach` (done in `videos-create`; the specs for SI-03.9–03.13 don't mention it).
  - The helper spies on `app.get(MailService)` instead of `(authService as any).mailService`: same singleton, but typed. `test/helpers/**` is not covered by the ESLint test-file relaxation of `unsafe-*` rules. The auth suite now imports `captureConfirmationToken`/`registerConfirmAndLogin` from the helper; behaviour unchanged (auth e2e green).
  - `VideosModule` now imports `StorageModule`; `videos.module.spec.ts` (from SI-03.7) gained a global `ConfigModule` with `storageConfig` so the module still compiles in isolation.
  - Title default strips the extension via `path.extname` and truncates to 100 chars; an explicit `title` is trimmed by the DTO `@Transform`. `extname('clip')` = `''`, so a file name without an extension is rejected as `UNSUPPORTED_VIDEO_FORMAT`.
  - When `createDraft` fails, the multipart abort is best-effort: an abort failure is logged as a warning and the original error is rethrown; the reconciliation sweep (SI-03.17) is the safety net.
  - `metadata.ts` (Swagger CLI plugin output) was not regenerated; `openapi.json` regeneration belongs to SI-03.19.
  - Wrote one throwaway log to the host's `/tmp/full.log` while diagnosing (should have used the session scratchpad); it is outside the repo.

### SI-03.14 — MediaToolsService: wrapper tipado de ffprobe/ffmpeg
- **Status:** completed
- **Tests:** 34 passing across 3 suites (`probe-parser.spec.ts`, `media-tool-error.spec.ts`, `media-tools.service.integration-spec.ts` with real ffmpeg 5.1.9 + MinIO, ~9 s); 0 leftover fixture dirs
- **Observations:**
  - `ProbeResult` uses the snake_case names of `VideoMetadata` (`video_codec`, `audio_codec`, `format_name`, `bit_rate`, `frame_rate`) plus `duration`/`size`/`width`/`height`, so SI-03.15 can map it straight into `markReady`. `duration` is `number | null`, because ffprobe omits it for some inputs (e.g. the JPEG the test probes to check the thumbnail size). SI-03.15's `assertPlayable` must decide what a missing duration means.
  - `frame_rate` is the raw fraction result (`30000/1001` → 29.97002997…), not rounded; the plan doesn't specify rounding.
  - `extractFrame` throws `MediaToolError('invalid_media')` when ffmpeg exits 0 but writes no bytes (e.g. a seek past the end), so the caller never stores an empty thumbnail.
  - `probe` maps unparseable JSON output to `invalid_media`. A process killed by the `execFile` timeout is always `transient`, even if stderr matches a "permanent" pattern.
  - An HTTP 404 from storage (missing object) classifies as `transient`, following the plan's "all others → transient" rule. In practice SI-03.15 only probes after `HeadObject` succeeded at completion, so a 404 there would mean the object vanished. Retrying until attempts run out (→ `processing_error`) seems acceptable; if a 404 should fail fast as permanent instead, that's a plan decision.
  - `MediaToolsService` is a bare `@Injectable()` with no module of its own; the plan wires it into the worker graph in SI-03.15/03.16.
  - Fixtures: the 1080p clip is 1 s long with `-preset ultrafast`, and the VP9 clip uses `-deadline realtime`, to keep generation fast (whole integration suite ~9 s). The corrupt `.mp4` is the first 1 KiB of the H.264 fixture; ffmpeg writes the `moov` atom at the end, so the head alone triggers `moov atom not found`.

### SI-03.9 — Endpoint GET /videos/:id (leitura do dono)
- **Status:** completed
- **Tests:** 5 passing (`test/videos-get.e2e-spec.ts`, derived from `specs/videos-get.plan.md`; the SI's Tests section is the empty form); 0 leftover multipart uploads
- **Observations:**
  - `VideosController` now injects `VideosService` too (for `findOwnedOrFail`) alongside `VideoUploadsService`; the handler is just `findOwnedOrFail` → `VideoResponseDto.fromEntity`.
  - Each test creates two users (owner and stranger), which is 6 auth requests, so `beforeEach` clears the throttler storage, as in `videos-create`.
  - The 404 test asserts that the stranger's 404 body and the random-UUID 404 body are byte-identical (`toEqual`), covering the "doesn't leak existence" AC.

### SI-03.10 — Endpoint GET /videos/:id/upload (estado para retomada)
- **Status:** completed
- **Tests:** 28 passing in `video-uploads.service.spec.ts` + `video-uploads.service.integration-spec.ts` (10 new unit cases, 1 new integration case against real MinIO); e2e `test/videos-upload-status.e2e-spec.ts` 4 passing; 0 leftover multipart uploads
- **Observations:**
  - **Spec deviation:** scenario 1.2 of `specs/videos-upload-status.plan.md` gets its part URLs from `POST /videos/:id/upload/part-urls`, which only exists after SI-03.11 (both SIs depend only on SI-03.8). The e2e signs the two URLs with `StorageService.presignUploadPart` (the same public client the endpoint will use) and then PUTs 5 MiB / 1 MiB as specified. Once SI-03.11 lands, the scenario can switch to the endpoint.
  - The status guard lives in a private `findOwnedDraftOrFail` (ownership first, then `draft`), so non-owners always get 404 and never 409. SI-03.11 and SI-03.12 can reuse it.
  - **Fixed a latent leak in the SI-03.8 integration spec:** its `afterAll` looked up each video's `upload_id` in the DB, but `beforeEach` wipes the rows, so with a second test the first test's multipart upload would never be aborted. Now `upload_id`s are recorded in a Map at creation, as the e2e suites do.
  - `UploadStatus`/`UploadedPartStatus` are plain interfaces in the service; `UploadStatusResponseDto.from` maps them, mirroring `CreateVideoResponseDto`.
  - `prettier --write` and the ESLint `prettier/prettier` rule disagreed on one block of the e2e file (`update(...)` call wrapping); `eslint --fix` resolved it, and both now pass.

### SI-03.11 — Endpoint POST /videos/:id/upload/part-urls (URLs pré-assinadas de partes)
- **Status:** completed
- **Tests:** 37 passing in `video-uploads.service.spec.ts` + `video-uploads.service.integration-spec.ts` (8 new unit cases, 1 new integration case against real MinIO); e2e 10 passing (`test/videos-upload-part-urls.e2e-spec.ts` 6, derived from `specs/videos-upload-part-urls.plan.md`, + the updated `test/videos-upload-status.e2e-spec.ts` 4); 0 leftover multipart uploads
- **Observations:**
  - **Maestro request applied:** `test/videos-upload-status.e2e-spec.ts` scenario `lista-partes-ja-enviadas` now gets its URLs from `POST /videos/:id/upload/part-urls` instead of signing them through `StorageService`, matching the original test plan (the SI-03.10 deviation is gone).
  - `expires_in` is the `expiresIn` that `StorageService.presignUploadPart` reports for the first URL; every URL in a batch is signed with the same configured TTL. The method relies on the DTO's `@ArrayMinSize(1)` for a non-empty batch.
  - The part-count check reuses the private `uploadPlan(declared_size)` and runs after the ownership/draft guard, so a non-owner asking for part 99 still gets 404.
  - Scenario 1.3 (TTL=600) compiles a second `AppModule` instance after setting `process.env.S3_UPLOAD_PART_URL_TTL_SECONDS = '600'`. The `registerAs` factories read `process.env` at compile time, so the new value applies; the original is restored in that block's `afterAll`. The e2e file has a local `createApp()` to build both instances with the `main.ts` global config.

### SI-03.15 — VideoProcessingService: extração de metadados e geração de thumbnail
- **Status:** completed
- **Tests:** 52 passing across 4 suites (`playback-allowlist.spec.ts`, `video-processing.service.spec.ts`, `video-processing.service.integration-spec.ts` 7 with real Postgres + MinIO + FFmpeg ~12 s, and `media/probe-parser.spec.ts` with 2 new cases); fix loop 1/3; 0 leftover fixture dirs and 0 leftover objects under `videos/`
- **Observations:**
  - **Maestro decision (from the SI-03.14 review), applied:** `parseProbeOutput` (SI-03.14 file) falls back to the video stream's `duration` when `format.duration` is missing (format still takes precedence; 2 new parser cases). `VideoProcessingService` throws `PermanentProcessingError('invalid_media')` when neither exists, before extracting a thumbnail. Storage 404 stays `transient`, as planned.
  - `MediaToolError('invalid_media')` becomes `PermanentProcessingError('invalid_media')` for both `probe` **and** `extractFrame` (the plan names only `probe`; a frame that cannot be decoded is just as permanent). `transient` media errors, storage errors and a missing original after `headObject` are rethrown unchanged so BullMQ retries them.
  - `process()` only throws; marking the video `failed` is the consumer's job (`@OnWorkerEvent('failed')`, SI-03.16), per the Events/Messages spec. A lost `markReady` transition (returns `false`) is logged as a warning, not thrown.
  - `assertPlayable` matches the container against the comma-separated items of `format_name` (`mov,mp4,…` / `matroska,webm`) instead of a raw substring, so e.g. `notmp4` does not pass. The thumbnail is stored before `headObject`/`markReady`; on a retry it is simply overwritten.
  - **Fix attempt 1 (test-only):** the integration test checked the thumbnail's `Content-Type` and ETag with `HEAD` on a presigned URL, which MinIO rejects with 403 because the signature covers GET only. It now reads headers through a 1-byte ranged GET (`206`). Service code unchanged.
  - The integration spec adds `TypeOrmModule.forFeature([User])` (same `Channel#user` module-graph gap noted in SI-03.8); `VideoProcessingModule` imports `VideosModule`, so the worker graph in SI-03.16 inherits the gap.
  - `VideoProcessingModule` exports `VideoProcessingService` so the worker module (SI-03.16) can consume it; it has no `@Processor`.

### SI-03.12 — Endpoint POST /videos/:id/upload/complete (conclusão + disparo do processamento)
- **Status:** completed
- **Tests:** 50 passing in `video-uploads.service.spec.ts` + `video-uploads.service.integration-spec.ts` + `videos.module.spec.ts` (11 new unit cases, 1 new integration case with real Postgres + MinIO + Redis uploading 64 MiB + 1 MiB); e2e `test/videos-upload-complete.e2e-spec.ts` 7 passing (derived from `specs/videos-upload-complete.plan.md`); full e2e suite 81 passing (8 suites); 0 leftover multipart uploads
- **Observations:**
  - `complete()` checks the stored object with one `headObject` for both paths: after `CompleteMultipartUpload`, or when `listParts` returns `null` (upload already assembled by an earlier call that crashed before the status change). A missing object → `UPLOAD_INCOMPLETE`; a size ≠ `declared_size` (or > 10 GiB) → delete the object, `markFailed('size_mismatch', draft)`, `UPLOAD_SIZE_MISMATCH`. The response re-reads the video (`findOwnedOrFail`) so it reflects `processing` and `processing_started_at`.
  - `VideosModule` now imports `VideoProcessingQueueModule`, so `AppModule` (and every e2e suite) loads BullMQ. This is the first real use of the SI-03.5 ESM transform in `test/jest-e2e.json`, and it works (all 8 e2e suites green). `videos.module.spec.ts` now loads `queueConfig` too.
  - **Spec typo:** scenario 2.2 of `specs/videos-upload-complete.plan.md` sets `failure_reason = 'abandoned_upload'`; the Data Model value is `upload_abandoned`, which the e2e uses (the column is a plain varchar, so the scenario's outcome does not depend on it).
  - **Post-review fix (maestro request, inside SI-03.12 scope, committed separately):** a client that uploads non-last parts smaller than 5 MiB whose sizes still add up to `declared_size` made storage reject `CompleteMultipartUpload` with `EntityTooSmall`, which surfaced as a 500. `complete()` now catches that error (`isS3Error(err, S3_ERROR_NAMES.ENTITY_TOO_SMALL)`, with `ENTITY_TOO_SMALL: 'EntityTooSmall'` added to `src/storage/storage.constants.ts`) and throws `UploadIncompleteException` → `409 UPLOAD_INCOMPLETE`. The video stays `draft` and the multipart upload stays open, so the client can re-upload the bad parts. Any other storage error from the assembly is still rethrown unchanged. 2 new unit cases in `video-uploads.service.spec.ts` (the mapping with no delete/abort/markFailed/markProcessing/enqueue; another `S3ServiceException` rethrown as-is). `video-uploads.service.spec.ts` + `video-uploads.service.integration-spec.ts`: 51 passing; `tsc` and lint clean.
  - After the e2e run, Redis keeps `streamtube-test:video-processing:meta` (BullMQ's queue-level metadata hash, re-created after `obliterate`); no job, wait or active keys are left.

### SI-03.13 — Endpoints de entrega: streaming, download e thumbnail
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.16 — Runtime do worker: consumer BullMQ, entrypoint separado e serviço Compose `video-worker`
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.17 — Sweep de reconciliação: job scheduler `reconcile-videos`
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.19 — OpenAPI: completar schemas de vídeos e regenerar `openapi.json`
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.18 — E2E do pipeline completo: upload → processamento → streaming/download
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.20 — Documentação: seção de vídeos nos CLAUDE.md e estratégia de testes de storage/fila
- **Status:** pending
- **Tests:** —
- **Observations:** none
