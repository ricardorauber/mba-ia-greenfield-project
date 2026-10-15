# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 8/20 completed

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
  - **ESCALATION — SI-03.6 regression in `src/database/migrations.integration-spec.ts`:** its `beforeAll` drops `MANAGED_TABLES` in parallel (`Promise.all` of `DROP TABLE ... CASCADE`). Since SI-03.6 added `videos` (FK → `channels`), dropping `channels CASCADE` and `videos` concurrently can hit Postgres `deadlock detected` (a timing race; it passed when run alone in SI-03.6 and SI-03.8). In the full `npm test` run it deadlocked. `afterAll` then couldn't re-apply the migrations, so the shared DB was left with only a stray `channels` table and an empty `migrations` table, and 14 later suites failed on missing tables. The dev DB was restored manually (dropped the stray `channels` with one auth-fixture row and both enum types, then `npm run migration:run` → 3 migrations). Not fixed here, because the skill says not to edit a completed SI quietly. Proposed fix: run the DROPs sequentially (or as a single `DROP TABLE IF EXISTS a, b, … CASCADE`), as a bugfix before continuing.
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
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9 — Endpoint GET /videos/:id (leitura do dono)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.10 — Endpoint GET /videos/:id/upload (estado para retomada)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.11 — Endpoint POST /videos/:id/upload/part-urls (URLs pré-assinadas de partes)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.15 — VideoProcessingService: extração de metadados e geração de thumbnail
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.12 — Endpoint POST /videos/:id/upload/complete (conclusão + disparo do processamento)
- **Status:** pending
- **Tests:** —
- **Observations:** none

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
