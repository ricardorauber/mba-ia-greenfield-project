# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 5/20 completed

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
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.7 — VideosService: pré-cadastro com slug único, leitura do dono e transições condicionais
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — Endpoint POST /videos (início do upload + pré-cadastro do rascunho)
- **Status:** pending
- **Tests:** —
- **Observations:** none

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
