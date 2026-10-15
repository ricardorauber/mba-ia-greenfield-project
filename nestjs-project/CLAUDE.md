# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit + integration tests (script already passes --runInBand)
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report (--runInBand)
npm run test:e2e                         # End-to-end tests (--runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`, which the `test`, `test:cov` and `test:e2e` scripts already pass:

```bash
docker compose exec nestjs-api npm test
docker compose exec nestjs-api npm run test:e2e
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.

## Videos

Upload, processing and delivery of videos (phase 03). Plan and decisions: `../docs/phases/phase-03-videos/phase-03-videos.md`.

### Services

| Service | Port(s) | Role |
|---|---|---|
| `minio` | `9000` (S3 API), `9001` (console) | Object storage, image `pgsty/minio`, data in the `minio-data` volume |
| `minio-init` | — | One-shot: creates the private bucket `S3_BUCKET` and exits `0` (idempotent on every `up`) |
| `redis` | `6379` | BullMQ broker, started with `--maxmemory-policy noeviction` |
| `video-worker` | none | Same image and code as `nestjs-api`, entrypoint `src/worker.ts` (`npm run start:worker:dev`), no HTTP server |

Besides `db` and `mailpit`, `nestjs-api` also waits for `redis` (healthy) and `minio-init` (completed successfully); `video-worker` waits for `db`, `redis` and `minio-init`.

Readiness checks (host machine):

```bash
docker compose ps -a                         # minio and redis "healthy", minio-init "Exited (0)", video-worker "Up"
docker compose exec redis redis-cli ping     # PONG
docker compose logs minio-init               # "Bucket created successfully `local/streamtube-videos`."
docker compose logs video-worker             # "Video worker ready, consuming video-processing"
```

### Environment variables

Defined in `.env` / `.env.example`, validated by `src/config/env.validation.ts`, read through the `storage` and `queue` namespaces (`src/config/storage.config.ts`, `src/config/queue.config.ts`).

| Variable | Dev value | Notes |
|---|---|---|
| `S3_ENDPOINT` | `http://minio:9000` | Server-side client (API and worker). Unset on AWS S3 |
| `S3_PUBLIC_ENDPOINT` | `http://localhost:9000` | Host signed into browser-facing presigned URLs; defaults to `S3_ENDPOINT` |
| `S3_REGION` | `us-east-1` | |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | `streamtube` / `streamtube-secret` | Required; also MinIO's root credentials (secret ≥ 8 chars) |
| `S3_BUCKET` | `streamtube-videos` | Private bucket |
| `S3_FORCE_PATH_STYLE` | `true` | Required by MinIO |
| `S3_UPLOAD_PART_URL_TTL_SECONDS` | `3600` | Part URL lifetime (60..604800) |
| `S3_DELIVERY_URL_TTL_SECONDS` | `14400` | Stream/download/thumbnail URL lifetime (60..604800) |
| `REDIS_HOST` / `REDIS_PORT` | `redis` / `6379` | |
| `QUEUE_PREFIX` | `streamtube` | Redis key prefix of every queue |

### HTTP flow

All routes require `Authorization: Bearer <access_token>` and only serve the owner (another user's video is a `404 VIDEO_NOT_FOUND`).

1. `POST /videos` `{ file_name, mime_type, size, title? }` → `201`, video in `draft` plus `upload: { part_size: 67108864, part_count }`. Only `video/mp4` (`.mp4`) and `video/webm` (`.webm`), up to 10 GiB.
2. `POST /videos/:id/upload/part-urls` `{ part_numbers: [...] }` (1..100 per call) → `{ expires_in, parts: [{ part_number, url }] }`.
3. The client `PUT`s each 64 MiB part straight to its `url` (storage, not the API) and keeps nothing else.
4. Resume after an interruption: `GET /videos/:id/upload` → `uploaded_parts`; request URLs only for the missing parts.
5. `POST /videos/:id/upload/complete` → `200`, status `processing`, job `process-video` queued (idempotent on `processing`/`ready`).
6. Poll `GET /videos/:id` until `ready` (or `failed` with `failure_reason`).
7. `GET /videos/:id/stream`, `/download`, `/thumbnail` → `302` to a presigned URL (`Cache-Control: private, no-store`); storage serves `Range`/`206`.

Storage layout: `videos/{videoId}/original` and `videos/{videoId}/thumbnail.jpg` (`src/videos/video-storage-keys.ts`).

### Worker

- Queues (`src/video-processing/video-processing.queue.ts`): `video-processing` (job `process-video`, `jobId` = video id, 5 attempts with exponential backoff) and `video-reconciliation` (job scheduler `reconcile-videos` every 15 min: fails drafts older than 24 h as `upload_abandoned`, re-enqueues videos `processing` for more than 1 h).
- Consumers are registered only in `src/worker.module.ts` (`VideoProcessingWorkerModule`); the API only produces jobs.
- Commands (inside the container): `npm run start:worker` runs `dist/worker` (after `npm run build`); `npm run start:worker:dev` runs `src/worker.ts` with `node --watch` and is what the `video-worker` service uses. The script starts with `exec` so `docker compose stop video-worker` delivers SIGTERM to Node and the worker shuts down gracefully (logs `Video worker shut down (SIGTERM)`).
- FFmpeg/ffprobe come from the shared `Dockerfile.dev` (Debian 12 package).

### OpenAPI export

`npm run openapi:export` runs `nest build && node dist/openapi-export.js`: the `@nestjs/swagger` CLI plugin only runs in `nest build`, and without it request DTOs export with no properties. It rewrites `dist/`, so do not run it while `npm run start:dev` is running.

### Testing videos

- Tests use real MinIO, Redis, PostgreSQL and FFmpeg — no storage, queue or media mocks.
- `src/test/setup-test-env.ts` (first Jest `setupFiles` entry in both configs) sets `QUEUE_PREFIX=streamtube-test` and `S3_PUBLIC_ENDPOINT=http://minio:9000` before `dotenv/config`, so tests never touch the dev queues (the dev `video-worker` keeps running) and presigned URLs are reachable from inside the container.
- Suites that start their own BullMQ workers or schedulers set a unique prefix per file (`${QUEUE_PREFIX}-<name>-<uuid>`) and call `queue.obliterate({ force: true })` in `afterAll`.
- Storage cleanup: `StorageService.deletePrefix(videoPrefix(id))` for every video created, plus `abortMultipartUpload` for uploads left open.
- Media fixtures are generated at test time by `createVideoFixtures()` in `src/test/video-fixtures.ts`; call the returned `cleanup()` in `afterAll`.
- E2E suites authenticate with `createAuthenticatedUser(app)` from `test/helpers/auth.helper.ts`; it makes 3 auth requests, so clear `ThrottlerStorage` in `beforeEach`.
- `@nestjs/bullmq` and `@nestjs/bull-shared` are ESM-only; both Jest configs transform them through ts-jest (`transformIgnorePatterns`) — keep that if you add Jest configs.

### Production notes

- AWS S3: leave `S3_ENDPOINT` unset (the SDK resolves the regional endpoint) and set `S3_PUBLIC_ENDPOINT` only if browsers must reach a different host.
- Bucket CORS must allow `PUT` and `GET` from the frontend origin and expose the `ETag` header (so the browser can confirm each part `PUT`; the API itself reads the ETags through `ListParts`). Locally `MINIO_API_CORS_ALLOW_ORIGIN: "*"` in `compose.yaml` covers this for dev only.
- Add a lifecycle rule `AbortIncompleteMultipartUpload` as defense in depth; the `reconcile-videos` sweep is the primary cleanup of abandoned uploads.
