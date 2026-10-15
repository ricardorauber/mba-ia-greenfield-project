---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-10-15
scope_description: "Backend side of Phase 03: how S3-compatible object storage is used (client lib, local MinIO image, endpoint topology, key layout), queue technology and video worker runtime, resumable 10GB direct-to-storage upload, processing trigger, FFmpeg/ffprobe metadata + thumbnail extraction, video status lifecycle and failure handling, unique public video identifier, and streaming/download delivery."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — owns every TD below: API endpoints (upload orchestration, delivery URLs), the video worker (separate Compose service), and the Compose infrastructure (object storage, queue broker). All service-to-service hosts use Compose service names (`db`, `minio`, `redis`, …).
- `next-frontend/` — no open decision in this document. The video UI is out of scope for this phase. The TDs marked `Cross-layer` (TD-07, TD-14, TD-15) define the HTTP contracts that the frontend will consume in later phases. Under `next-frontend-config-base/TD-03` (Strict BFF), the small JSON control-plane calls go through BFF Route Handlers. Large byte transfers go browser ↔ object storage directly through presigned URLs, as that TD already anticipated.

**Constraints inherited and not reopened:** S3-compatible object storage (MinIO locally, AWS S3 in production) per the brief and `docs/diagrams/software-arch.mermaid`; `@nestjs/config` + Joi env validation (`phase-01-configuracao-base/TD-01..TD-03`); custom JWT guards (`phase-02-auth/TD-02`); domain error envelope (`phase-02-auth/TD-07`); OpenAPI artifact consumed by the frontend via codegen (`openapi-docs-nestjs/TD-02`, `next-frontend-openapi-typing/TD-01`); Strict BFF (`next-frontend-config-base/TD-03`).

**Installed baseline checked:** `@nestjs/core` 11.1.16, `typeorm` 0.3.28, Node 25 (`node:25.6.0-slim` dev image, Debian-based). No storage, queue, or FFmpeg dependency is installed yet.

---

## TD-01: Message Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram leaves the queue as "TBD". The API publishes one job per uploaded video, and the worker consumes it. Jobs are long-running (FFmpeg over files up to 10GB), must survive worker crashes, and need retry with backoff (see TD-13). The choice adds or avoids a new Compose service and decides which NestJS integration the API and worker use.

**Options:**

### Option A: BullMQ on Redis (`@nestjs/bullmq`)
- Redis-backed job queue with official NestJS integration (`BullModule.forRoot`, `registerQueue`, `@Processor` + `WorkerHost`). Adds a `redis` Compose service.
- **Pros:** First-party NestJS module with DI-friendly producers and consumers. Built-in `attempts` + exponential `backoff`, `jobId` deduplication, `UnrecoverableError` for permanent failures, and lock renewal with stalled-job recovery. Stalled-job recovery fits long FFmpeg jobs whose worker may die mid-run. Repeatable jobs can drive the TD-13 reconciliation sweep without another lib.
- **Cons:** New infrastructure (Redis) to run, and later to secure and back up. Redis must use `maxmemory-policy noeviction`, or BullMQ loses jobs. Enqueueing is not transactional with the PostgreSQL status update: a dual-write gap that TD-13's reconciliation must close.

### Option B: RabbitMQ (`@nestjs/microservices` RMQ transport or `@golevelup/nestjs-rabbitmq`)
- AMQP broker with durable queues and acks. Adds a `rabbitmq` Compose service.
- **Pros:** Standard message broker with strong delivery guarantees and a management UI. Language-agnostic, so a non-Node worker remains possible.
- **Cons:** It is a message broker, not a job queue. Retry with backoff, delayed redelivery and job state need dead-letter exchanges, TTL queues or plugins. The Nest microservices RMQ transport is oriented to request/response and event patterns, not job lifecycles. It brings the most operational and conceptual weight of the three options for a single job type.

### Option C: PostgreSQL-backed queue (`pg-boss`)
- Job queue stored in the existing PostgreSQL database (`SKIP LOCKED`). No new container. Requires Node ≥ 22.12 and PostgreSQL ≥ 13, both satisfied.
- **Pros:** Zero new infrastructure. Enqueue can share a transaction with the video status update, which closes the dual-write gap. Built-in `retryLimit`/`retryBackoff` and singleton keys. Backups and observability come with the database.
- **Cons:** No official NestJS module (only community wrappers or a hand-written provider). Queue polling adds load to the same database that serves the API. Smaller ecosystem than BullMQ. Folding the "Message Queue" container into the DB diverges from the architecture diagram.

**Recommendation:** **Option A (BullMQ + Redis)**. It is the NestJS-documented queue integration. It provides the stalled-job recovery that long FFmpeg runs need, and a Redis container is a small operational cost in a Compose-only environment. pg-boss is a close second and wins if avoiding new infrastructure matters more than first-party Nest integration, because its transactional enqueue removes the dual-write concern.

**Decision:** A (BullMQ on Redis via `@nestjs/bullmq`) — first-party NestJS integration plus stalled-job recovery for long FFmpeg runs.
**Libraries:** @nestjs/bullmq, bullmq, ioredis

**Note:** Exact pins checked on 2026-10-15: `@nestjs/bullmq@12.0.0` (peers: `@nestjs/common`/`@nestjs/core` `^10 || ^11 || ^12`, `bullmq` `^3 … ^6`, compatible with the installed `@nestjs/core` 11.1.16), `bullmq@6.3.15`, `ioredis@6.0.0`. Since BullMQ 6, `ioredis` is an optional peer dependency that must be installed explicitly; ioredis 6 requires Node ≥ 20 and defaults to RESP3. Redis runs as a `redis` Compose service (`redis:8.10.2-alpine`) with `maxmemory-policy noeviction`; the API and worker reach it by its service name.

---

## TD-02: Video Worker Runtime Topology

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The architecture diagram has a dedicated "Video Worker" container. Phase 03 requires processing "sem impacto na performance". The worker needs the `videos` entity, TypeORM config, the storage client and the queue consumer. It also needs FFmpeg binaries, which the API does not need. Depends on TD-01.

**Options:**

### Option A: Same `nestjs-project` codebase, separate entrypoint and Compose service
- A second bootstrap (e.g., `NestFactory.createApplicationContext(WorkerModule)`, with no HTTP server) is built from the same project and run as a `video-worker` Compose service. The worker image adds FFmpeg. Nest CLI monorepo mode (`apps/api`, `apps/worker`) is a variant of this option.
- **Pros:** Reuses entities, migrations, config namespaces, Joi schema and the storage module with no duplication. One `package.json` and one lint/test setup. CPU-heavy processing is isolated from the API process and can scale independently (`replicas`).
- **Cons:** The worker ships the API's dependencies, and the reverse unless image stages split them. Module boundaries need discipline so the worker does not pull in HTTP-only modules (guards, controllers).

### Option B: New standalone subproject (e.g., `video-worker/`)
- Separate package with its own manifest, Dockerfile and possibly its own language/runtime.
- **Pros:** Hard isolation. Dependencies are minimal. Free choice of runtime.
- **Cons:** Duplicates the entity/DB access layer and config validation, or requires a shared package that the repo does not have (no workspaces tooling). Adds a third subproject to lint, test and keep in sync for a single job type.

### Option C: In-process consumer inside the API
- The queue processor is registered in the API's own Nest application.
- **Pros:** Simplest. No new service.
- **Cons:** FFmpeg CPU and I/O compete with HTTP request handling, which contradicts "sem impacto na performance" and the diagram's separate worker container. The API image would need FFmpeg.

**Recommendation:** **Option A**. Running in a separate container satisfies the architecture and the performance requirement, and sharing the codebase avoids duplicating the persistence layer in a repo with no shared-package tooling.

**Decision:** A (same `nestjs-project` codebase, separate worker entrypoint + `video-worker` Compose service)
**Libraries:** —

**Note:** In dev, `nestjs-api` and `video-worker` share the `Dockerfile.dev` image (`node:25.6.0-slim`, Debian 12 bookworm), and FFmpeg is installed in that image (`apt install ffmpeg`; Debian candidate `7:5.1.9-0+deb12u1`). Reason: the full Jest suite (unit + integration + e2e) runs inside the `nestjs-api` container, and the worker integration tests need real `ffprobe`/`ffmpeg` and generate fixture clips with ffmpeg's `lavfi` `testsrc`. This overrides the option's "worker image adds FFmpeg" wording for the dev image. Splitting the API and worker images for production stays possible later.

---

## TD-03: S3 Client Library

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The API (multipart orchestration, presigning, head/delete) and the worker (presigned reads, thumbnail upload) both talk to S3-compatible storage. The client must work unchanged against MinIO (path-style, custom endpoint) and AWS S3 (virtual-hosted, default endpoint).

**Options:**

### Option A: AWS SDK for JavaScript v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)
- Modular official SDK. `endpoint` + `forcePathStyle: true` target MinIO. `getSignedUrl(client, command)` presigns any command (`UploadPartCommand`, `GetObjectCommand`, …).
- **Pros:** It is the production target's own SDK, so dev/prod behavior matches. It presigns any operation, including multipart parts and `ResponseContentDisposition` for downloads. Strong TypeScript types. Actively maintained.
- **Cons:** Verbose command-object API. Some S3 features MinIO lacks surface only at runtime.

### Option B: MinIO JavaScript client (`minio`)
- MinIO's S3-compatible SDK, with a simpler high-level API (`presignedUrl`, `putObject`, `fPutObject`).
- **Pros:** Concise API. Works against AWS S3 as well.
- **Cons:** It comes from the same vendor whose community server repository is now archived, so long-term maintenance of the SDK is uncertain. Presigning multipart parts is less direct (raw `reqParams`). Using a non-AWS SDK against production S3 adds compatibility risk.

**Recommendation:** **Option A (AWS SDK v3)**. Production is AWS S3, so its official SDK minimizes dev/prod divergence, and it presigns every operation TD-07 and TD-15 need.

**Decision:** A (AWS SDK v3: `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

**Note:** Exact pins checked on 2026-10-15: `@aws-sdk/client-s3@3.1152.0` and `@aws-sdk/s3-request-presigner@3.1152.0`. Both are always upgraded together (Node ≥ 20 engine).

---

## TD-04: Local S3-Compatible Image Sourcing (MinIO)

**Scope:** Repo-wide

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** ⚠️ **Discrepancy flagged:** the brief assumes MinIO runs locally in Docker. MinIO Inc. stopped publishing community Docker images in October 2025. The `minio/minio` GitHub repository is now archived and states "no longer maintained", with source-only distribution. Docker Hub images were reportedly removed, and the `quay.io/minio/minio` mirror's `latest` stays on the September 2025 community release. Per the brief, the storage choice (S3-compatible, MinIO locally) is not reopened. Switching to a different S3-compatible server such as RustFS or Garage is therefore excluded here. Only the image source for the Compose service is decided. The same question applies to the `mc` client image used for bucket bootstrap.

**Options:**

### Option A: Pin the last official community image (`quay.io/minio/minio:RELEASE.<2025 tag>`)
- Pin an exact final community release tag from the Quay mirror, plus the matching `quay.io/minio/mc`.
- **Pros:** Official provenance. No build step. Fully adequate for a local-only dev/test fixture that is never internet-facing.
- **Cons:** Frozen and unpatched: the October 2025 CVE fix was never published as an image. Availability depends on a mirror the vendor no longer maintains.

### Option B: Maintained community fork, drop-in image (`pgsty/minio` / `pgsty/silo`)
- A Pigsty-run AGPLv3 fork that keeps the same env vars and data format, with minimal changes from upstream.
- **Pros:** Still receives releases and fixes. Drop-in replacement for Compose.
- **Cons:** Not affiliated with MinIO Inc. Relies on a small maintainer base. Naming is in flux (`minio` → `silo`), so tags must be checked when pinning.

### Option C: Build MinIO from source in the repo
- A Dockerfile that runs `go install github.com/minio/minio@<tag>` and builds a local image.
- **Pros:** Full control over the version. No third-party image.
- **Cons:** Requires a Go toolchain and slow image builds. The archived source no longer receives fixes, so this adds work without fixing Option A's staleness.

**Recommendation:** **Option A**, with Option B as the fallback. MinIO is only a local stand-in for production S3, so a pinned official image is the lowest-risk choice for a dev fixture. If the Quay tag becomes unavailable, switch to the fork, which is a one-line `image:` change because env vars and data format are identical.

**Decision:** B (maintained fork `pgsty/minio`) — Option A is not viable.
**Libraries:** —

**Note:** The decision deliberately diverges from the Recommendation. On 2026-10-15, `docker manifest inspect` and `docker pull` showed that `minio/minio` and `quay.io/minio/minio` (including `RELEASE.2025-09-07T16-13-09Z` and `latest`), and `minio/mc` / `quay.io/minio/mc`, can no longer be pulled ("unauthorized" / "repository does not exist"). Pins: `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` (verified `minio version RELEASE.2026-08-04T00-00-00Z`) for the `minio` Compose service. Bucket bootstrap uses `pgsty/mc:RELEASE.2026-09-16T00-00-00Z`, or the AWS SDK if simpler; `/plan-build` makes that choice.

---

## TD-05: Storage Endpoint Topology for Presigned URLs (internal vs. public host)

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Reprodução via streaming (sem necessidade de download completo)"

**Context:** Inside Compose, the API and worker must reach storage at `http://minio:9000` (service name, per CLAUDE.md). The browser cannot resolve `minio`. A SigV4 presigned URL embeds and signs the host, so a URL signed for `minio:9000` is useless to the browser, and simply rewriting its host breaks the signature. The choice sets the canonical storage env-key contract (Joi schema + `compose.yaml` + `.env.example`). Depends on TD-03.

**Options:**

### Option A: Dual endpoint configuration
- `S3_ENDPOINT=http://minio:9000` is used for all server-side operations. `S3_PUBLIC_ENDPOINT=http://localhost:9000` (the host-mapped port) is used only by a second S3 client dedicated to presigning browser-facing URLs. Presigning makes no network call, so the API never needs to reach `localhost`. In production both are unset or equal (AWS default endpoint).
- **Pros:** No extra Compose service. Keeps the service-name rule for every server-side connection. The signature matches because the browser sends `Host: localhost:9000`. Small and explicit.
- **Cons:** Two client instances and two env keys to keep coherent. Developers must remember that presigned URLs for worker use (TD-12) are signed with the internal client.

### Option B: Reverse proxy fronting storage on a single public hostname
- A proxy service (nginx/Caddy) exposes storage at a hostname reachable from the browser. The API signs URLs for that hostname, and the proxy forwards to `minio:9000` while preserving the `Host` header.
- **Pros:** One public URL scheme that resembles a production CDN/custom-domain setup. Later the proxy can also serve the frontend and API under one origin.
- **Cons:** Adds a Compose service and proxy config. Host-header preservation is easy to get wrong, and the failures show up as opaque `SignatureDoesNotMatch` errors. Server-side code either still needs the internal endpoint, or routes internal traffic through the proxy needlessly.

**Recommendation:** **Option A**. It solves the signing problem with one env key and no new infrastructure, while every server-to-server connection keeps the Compose service name. `host.docker.internal` is not offered because it conflicts with the project's Docker networking rule.

**Decision:** A (dual endpoint: `S3_ENDPOINT` internal + `S3_PUBLIC_ENDPOINT` for browser-facing presigning)
**Libraries:** —

**Note:** Integration and e2e tests run inside the `nestjs-api` container, which cannot reach `localhost:9000`. The test environment therefore sets `S3_PUBLIC_ENDPOINT=http://minio:9000` (equal to the internal endpoint), so tests can `PUT`/`GET` presigned URLs for real.

---

## TD-06: Bucket and Object Key Layout

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The API writes originals (via presigned upload), the worker writes thumbnails, delivery reads both, and cleanup deletes them. The layout is a contract shared by the API, the worker, the bucket bootstrap in Compose, and future storage lifecycle rules. "Pontos de Atenção" asks to plan storage growth and cost from the start.

**Options:**

### Option A: Single private bucket, per-video prefix keyed by internal ID
- One bucket (e.g., `S3_BUCKET=streamtube`), with keys such as `videos/{videoId}/original` and `videos/{videoId}/thumbnail.jpg`. Phase 04's custom thumbnail can live alongside.
- **Pros:** Deleting a video means deleting one prefix. One bucket to bootstrap, configure CORS on and attach lifecycle rules to. Internal UUIDs never change and don't leak the public slug or the owner.
- **Cons:** Any per-asset-type policy (e.g., public thumbnails, different lifecycle rules) must use prefix-scoped rules instead of bucket-wide ones.

### Option B: Separate buckets per asset type
- For example `streamtube-videos` (private) and `streamtube-thumbnails` (possibly public-read/CDN), each with its own policy and lifecycle.
- **Pros:** Clean per-type policies, making thumbnails CDN-friendly. Cost reporting per bucket.
- **Cons:** More env keys and more bucket bootstrap. Video deletion spans two buckets. Benefits only materialize if TD-15 makes thumbnails public.

### Option C: Owner-scoped prefixes (`channels/{channelId}/videos/{videoId}/...`)
- Same as A, but prefixed by the owning channel.
- **Pros:** Per-channel storage usage can be computed by prefix listing, which helps with quota planning.
- **Cons:** Longer keys that encode ownership. Per-channel accounting is easier to keep in the DB (store `size_bytes` per video). No capability needs per-channel quotas.

**Recommendation:** **Option A**. One private bucket with per-video prefixes keeps bootstrap, CORS, lifecycle and deletion trivial. Storage-growth planning is better served by persisting `size_bytes` per video than by encoding owners in keys.

**Decision:** A (single private bucket, `videos/{videoId}/…` keys)
**Libraries:** —

---

## TD-07: Large Upload Protocol (10GB, resumable, not proxied by the API)

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** The upload must reach 10GB, must not tie up the API during the transfer, and must be resumable after connection loss ("Pontos de Atenção"). A single presigned `PUT` cannot do it on production S3, which caps a single PUT at 5 GiB. S3 multipart allows up to 10,000 parts of 5 MiB–5 GiB (no minimum for the last part). This is cross-layer because the handshake sequence (initiate → transfer → resume → complete) is implemented by both the backend and the future frontend. Under Strict BFF, the control-plane JSON goes through Next Route Handlers, and only the bytes go elsewhere. Depends on TD-03 and TD-05.

**Options:**

### Option A: S3 multipart upload with presigned part URLs, orchestrated by the API
- `POST /videos` creates the draft row and calls `CreateMultipartUpload`. It returns `videoId`, `uploadId`, the part size and the part count. The client requests presigned `UploadPart` URLs in batches and `PUT`s each part directly to storage. The client resumes by asking the API for the parts already stored (`ListParts`). The client calls a completion endpoint at the end (see TD-08). Typical parameters are 64 MiB parts (≈160 parts for 10 GiB) and short URL TTLs.
- **Pros:** Bytes never touch the API or the BFF. Resumability is native (re-upload only missing parts), and parts upload in parallel. Identical on MinIO and S3. No extra service.
- **Cons:** Custom handshake to implement on both sides. The browser must read each part's `ETag`, so storage CORS must expose `ETag`. Total-size limits cannot be enforced by presigned URLs alone: the API validates the declared size at initiation and the actual size at completion. Abandoned uploads leave orphan parts (see TD-13).

### Option B: tus resumable protocol via a dedicated tus server (`tusd` or `@tus/server` + `@tus/s3-store`)
- A separate tus service accepts `PATCH` chunks and writes them to S3 multipart internally. Hooks (`onUploadCreate`/`onUploadFinish`, or tusd HTTP hooks) call the API for auth and to create the draft.
- **Pros:** Open, standardized resumable protocol with mature clients (tus-js-client, Uppy). Resume semantics are handled by the libraries.
- **Cons:** Every byte flows through the tus server (client → tus → S3), so it needs scaling and bandwidth of its own. Adds a public-facing Compose service that the browser must reach directly, with auth bridged through hooks. Running it inside the API process would violate the "don't hold the API" requirement.

### Option C: Chunked upload through the API, which forwards parts to S3 multipart
- The client sends fixed-size chunks to an API endpoint, and the API forwards each chunk with `UploadPart`.
- **Pros:** Full server-side control and validation of each chunk. No storage CORS or public storage endpoint needed for upload.
- **Cons:** 10GB per upload passes through the API, and under Strict BFF through the Next BFF as well (a double proxy). This directly contradicts "sem impacto na performance". Memory and bandwidth pressure scales with concurrent uploads.

**Recommendation:** **Option A**. It is the only option where the data plane bypasses both the API and the BFF, as the Strict BFF decision anticipated for video payloads. It also resumes natively and needs no new service. The handshake cost is a few small JSON endpoints.

**Decision:** A (S3 multipart upload with presigned part URLs, orchestrated by the API)
**Libraries:** —

**Note:** The maximum size is 10 GiB (`10 * 1024^3` = 10,737,418,240 bytes). It is validated against the declared size at initiation (`POST /videos`) and checked again against the actual stored size at completion. The API fixes the part size at 64 MiB (67,108,864 bytes), with a smaller last part, so a 10 GiB upload has at most 160 parts.

---

## TD-08: Upload Completion Detection and Processing Trigger

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Processing must start automatically once the upload finishes. Someone must detect completion, move the video into processing, and enqueue the job. The choice determines whether storage needs event-notification configuration (Compose + env) and whether the trigger path is the same in dev (MinIO) and prod (S3). Depends on TD-01 and TD-07.

**Options:**

### Option A: API-driven completion endpoint
- The client calls `POST /videos/{id}/upload/complete`. The API completes the multipart upload (with ETags from the client or via `ListParts`), `HEAD`s the object to validate size, updates the status, and enqueues the job (`jobId = videoId` for idempotency).
- **Pros:** Identical in dev and prod. The API owns every state transition and its validation. No storage-side configuration. The same endpoint is safe to retry.
- **Cons:** If the client disconnects after the last part but before calling `complete`, the video stays in `uploading` until the client retries or TD-13's reconciliation handles it.

### Option B: Storage event notifications
- Storage emits `ObjectCreated` on `CompleteMultipartUpload`: MinIO via bucket notification targets (webhook/Redis/AMQP), AWS via SQS/EventBridge. A consumer updates the status and enqueues the job.
- **Pros:** The trigger fires even if the client never calls back after completion. Decoupled from the client.
- **Cons:** Dev and prod notification mechanisms differ entirely (MinIO targets vs. SQS/EventBridge), so it is two integrations to build and test. Someone still has to call `CompleteMultipartUpload`, which under TD-07 Option A is the API anyway. Adds notification configuration to Compose and needs an extra consumer.

**Recommendation:** **Option A**. Under TD-07 Option A the API already performs `CompleteMultipartUpload`, so it is the natural, environment-independent place to transition status and enqueue. The rare missing-callback case is covered by TD-13's reconciliation instead of a second event pipeline.

**Decision:** A (API-driven completion endpoint)
**Libraries:** —

---

## TD-09: Accepted Input Formats and Playback Compatibility

**Scope:** Backend

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Reprodução via streaming (sem necessidade de download completo)"

**Context:** Phase 03's processing scope is metadata extraction and a thumbnail, not transcoding. Browsers natively play only some containers and codecs (e.g., MP4/H.264/AAC, WebM/VP9/Opus). If arbitrary formats are accepted and streamed as-is, some uploads will be stored but never play. The accepted set is checked at the API (declared MIME/extension at initiation) and confirmed in the worker (ffprobe codecs). It surfaces to clients through OpenAPI and the error envelope.

**Options:**

### Option A: Allowlist browser-playable formats, validated twice
- The API rejects non-allowlisted MIME types/extensions at `POST /videos`. The worker confirms the real container/codecs with ffprobe and marks the video `failed` with a machine-readable reason if they are unsupported.
- **Pros:** Every `ready` video is playable through progressive streaming (TD-15) without transcoding. Fast feedback at upload start. Stays within the phase's processing scope.
- **Cons:** Rejects common camera/export formats (e.g., MKV, AVI, some HEVC MOV), so users must convert beforehand.

### Option B: Accept any format and transcode incompatible ones to MP4 (H.264/AAC)
- The worker transcodes whenever ffprobe reports a non-playable codec or container.
- **Pros:** Best user experience: anything uploads and plays.
- **Cons:** Transcoding up to 10GB is CPU- and time-intensive and doubles storage per video. It goes beyond the phase capability ("extração de duração e metadados"). Many more failure modes.

### Option C: Accept any format, no validation
- Store whatever arrives and only extract metadata.
- **Pros:** Simplest.
- **Cons:** Videos reach `ready` but fail in the player, which silently breaks the "Reprodução via streaming" capability.

**Recommendation:** **Option A**. It guarantees that "ready" means "playable" without adding transcoding, which the phase does not ask for. Option B is a natural future extension if format breadth becomes a requirement.

**Decision:** A (allowlist browser-playable formats, validated at the API and in the worker)
**Libraries:** —

**Note:** The allowlist is `video/mp4` (`.mp4`: H.264 video; AAC or MP3 audio, or no audio) and `video/webm` (`.webm`: VP8, VP9 or AV1 video; Opus or Vorbis audio, or no audio). The API checks the declared MIME type and extension at initiation. The worker confirms the real container and codecs with ffprobe, and on a mismatch sets the video to `failed` with a machine-readable reason.

---

## TD-10: Video Status Lifecycle Model

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** Phase 03 creates the video "como rascunho" when the upload starts and drives it through processing. Phase 04 owns the "Fluxo de rascunho → publicação" and shows a status column in the channel panel. Two concerns overlap here: whether the file is processed, and whether the video is published. The status values are exposed in API responses and flow to the frontend through the OpenAPI contract. Depends on TD-08 and TD-13.

**Options:**

### Option A: Single status enum
- One `status` column: `draft` (uploading) → `processing` → `ready` | `failed`. Phase 04 extends the same enum (e.g., `published`).
- **Pros:** One column, one state machine, and it matches the brief's wording. Simple queries.
- **Cons:** It conflates two independent axes. A `ready` video is still a draft for publication purposes, and Phase 04 must add states (or a second column anyway) to express "processed but unpublished" versus "published". The meaning of `draft` changes between phases.

### Option B: Two orthogonal fields — processing state and publication state
- `processing_status`: `uploading` → `processing` → `ready` | `failed`, plus a failure reason. A publication field defaults to `draft` in Phase 03. Phase 04 adds the publish transition and the guard "publish only when `ready`".
- **Pros:** "Pré-cadastro como rascunho" maps literally to the publication default. Phase 04 extends its own axis without changing Phase 03's state machine. Each transition has one owner (API/worker for processing, the user for publication).
- **Cons:** Two columns, and combinations must be guarded (e.g., no publishing while `processing`). The panel must combine both fields for display.

**Recommendation:** **Option B**. It keeps Phase 03's processing lifecycle stable when Phase 04 introduces publication, and keeps a clear owner per transition, in line with the project's single-responsibility principle. Option A forces Phase 04 to reshape a contract that the frontend already consumes.

**Decision:** A (single `status` enum: `draft` → `processing` → `ready` | `failed`) — follows the phase brief's lifecycle "rascunho → processando → pronto/erro" literally.
**Libraries:** —

**Note:** The decision deliberately diverges from the Recommendation (Option B). Phase 04 will express publication in its own field (e.g. `visibility` / `published_at`) without reshaping this enum. A failure reason is stored when `status = failed`.

**Note (draft scope, AMB-2):** The video belongs to the uploader's **channel**: `videos.channel_id` is an FK to `channels`, which is 1:1 with the user, and ownership is checked through the authenticated user's channel. Fields set when the upload starts:
- `title`, supplied by the client (optional; defaults to the original file name without its extension);
- the original file name;
- the declared MIME type;
- the declared size in bytes.

Description, visibility and category are not part of Phase 03. Editing video information belongs to Phase 04.

**Note (abandoned drafts, AMB-5):** The lifecycle has one more transition: `draft → failed` with failure reason `upload_abandoned`. The TD-13 reconciliation sweep applies it when a draft is still incomplete 24 hours after creation. The row is kept. The sweep is described in the TD-13 Note.

**Note (owner read, AMB-6):** The owner can read `status` and the failure reason through the single-video owner read defined in the TD-15 Note.

---

## TD-11: FFmpeg/ffprobe Integration Approach

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker extracts duration and metadata (ffprobe JSON: format, streams, codecs, resolution) and renders one frame as the thumbnail (ffmpeg with a seek before input). How the binaries are obtained and invoked affects the worker image, its testability, and its exposure to a deprecated wrapper. Depends on TD-02.

**Options:**

### Option A: Distro-packaged `ffmpeg`/`ffprobe` in the worker image + thin typed wrapper over `child_process`
- Install FFmpeg via `apt` in the worker image and call `ffprobe -print_format json -show_format -show_streams` and `ffmpeg -ss … -frames:v 1` with `execFile`/`spawn` behind a small injectable service.
- **Pros:** No third-party Node wrapper. Full control over arguments, timeouts and stderr capture. The wrapper is trivially mockable in unit tests and exercisable in integration tests. Security updates come from the base image.
- **Cons:** Argument building and output parsing are hand-written (small for two commands). The FFmpeg version is tied to the Debian release of the base image.

### Option B: `fluent-ffmpeg`
- Popular fluent wrapper around the system binaries (`ffprobe()`, `screenshots()`).
- **Pros:** Convenient high-level helpers (thumbnails, metadata) and many examples online.
- **Cons:** **Deprecated** on npm and no longer maintained; the README asks for new maintainers. Adopting it now creates immediate dependency debt.

### Option C: npm-bundled static binaries (`ffmpeg-static` / `@ffprobe-installer/ffprobe`) + `child_process`
- Same invocation as A, but the binaries come from npm packages downloaded at install time.
- **Pros:** Version pinned via the lockfile and independent of the base image.
- **Cons:** Large install-time binary downloads in every container that runs `npm install`, including the API. Platform-specific binaries can mismatch between macOS hosts and Linux containers. Updates depend on the package maintainers.

**Recommendation:** **Option A**. Two well-defined commands do not justify a wrapper library, `fluent-ffmpeg` is deprecated, and installing FFmpeg only in the worker image keeps it out of the API (consistent with TD-02).

**Decision:** A (distro `ffmpeg`/`ffprobe` + thin typed `child_process` wrapper)
**Libraries:** —

**Note:** FFmpeg comes from Debian 12's `ffmpeg` apt package (5.1.x) in the shared dev image, per the TD-02 Note. It is not an npm dependency. The "FFmpeg only in the worker image" wording of the Recommendation does not apply to the dev image.

**Note (processing outputs, AMB-3):**
- **Typed columns:** `duration` (seconds, numeric), `width`, `height`, and actual `size` in bytes.
- **jsonb `metadata` column:** video codec, audio codec (nullable), container/format name, bit rate, and frame rate.
- **Thumbnail:** one JPEG frame taken at 10% of the duration (0 s for clips shorter than 1 s), scaled to a maximum width of 1280 px with the aspect ratio kept, stored at key `videos/{videoId}/thumbnail.jpg`.

---

## TD-12: Worker Access to the Source Video (download vs. ranged remote read)

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The source can be up to 10GB. ffprobe needs only container headers (for MP4 the `moov` atom may sit at the end), and the thumbnail needs only the bytes around one frame. How the worker reads the object determines disk sizing for the worker container, processing time, and network transfer. Depends on TD-03, TD-05 (internal endpoint) and TD-11.

**Options:**

### Option A: ffprobe/ffmpeg read directly from a presigned GET URL (HTTP Range)
- The worker presigns a short-lived GET with the internal endpoint (`minio:9000`) and passes the URL as the input. FFmpeg's HTTP protocol issues Range requests and seeks to just the bytes it needs.
- **Pros:** Transfers megabytes instead of gigabytes. No large temp volume. Processing time is nearly independent of file size. Works the same against S3.
- **Cons:** Many small ranged requests, which is sensitive to storage latency. Pathological files (e.g., heavily fragmented containers) may read more. Errors mix network failures with media failures, so the retry policy (TD-13) must tell them apart.

### Option B: Download the full object to a temp volume, then process locally
- Stream `GetObject` to a file on a worker volume, run the tools on the file, then delete it.
- **Pros:** Simplest mental model. Local seeks are fast and deterministic. Isolates network issues to one download step.
- **Cons:** Transfers up to 10GB per job and needs disk headroom for concurrency × 10GB. Time scales with file size even though only kilobytes to megabytes are needed.

### Option C: Pipe the object stream into ffmpeg/ffprobe stdin
- `GetObject` body piped to the process's stdin.
- **Pros:** No temp disk.
- **Cons:** Pipes are not seekable. MP4 files with `moov` at the end can fail or force reading the whole stream. Thumbnail seeking degrades to sequential reads. This is unreliable for the most common upload format.

**Recommendation:** **Option A**. Both required operations need only a small, seekable fraction of the file, and ranged reads avoid moving 10GB per job. Option B remains a reasonable fallback inside the job when a ranged read fails for non-network reasons.

**Decision:** A (ffprobe/ffmpeg read directly from an internally-presigned GET URL via HTTP Range)
**Libraries:** —

---

## TD-13: Processing Failure, Retry, and Abandoned-Upload Cleanup Policy

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance"

**Context:** Failures fall into three groups:
- transient errors (storage/network hiccups, worker crash mid-job);
- permanent errors (corrupt file, unsupported codec per TD-09);
- abandoned uploads (the client never completes, leaving orphan multipart parts that cost storage).

There is also the dual-write gap between the DB status update and enqueueing (TD-01 Option A). The policy spans the queue, the DB status (TD-10), the worker and storage. Depends on TD-01, TD-08 and TD-10.

**Options:**

### Option A: Queue-native retries + terminal `failed`; storage lifecycle rule for abandoned parts
- Jobs get N attempts with exponential backoff. Permanent errors skip retries (BullMQ `UnrecoverableError` / pg-boss equivalent) and set `failed` with a reason. Incomplete multipart uploads are aborted by an `AbortIncompleteMultipartUpload` lifecycle rule (N days).
- **Pros:** Mostly configuration, little code. Handles transient and permanent errors distinctly.
- **Cons:** No safety net for the dual-write gap or for a missed `complete` callback. Rows can stay in `uploading`/`processing` forever. The lifecycle rule cleans storage but leaves orphan draft rows.

### Option B: Option A + application-level reconciliation sweep
- Adds a scheduled job (e.g., a repeatable queue job) that re-enqueues videos stuck in `processing` beyond a threshold. It also aborts the multipart upload and marks the video `failed` (or deletes the draft) for videos in `uploading` past a TTL.
- **Pros:** Closes the dual-write gap and the missed-callback case. DB and storage converge. Stuck states are visible and bounded. Idempotent jobs (`jobId = videoId`) make re-enqueueing safe.
- **Cons:** One more scheduled job to write and test. Thresholds must exceed the worst-case legitimate processing time.

### Option C: Fail fast, no automatic retry
- Any error sets `failed` immediately, and the user must re-upload.
- **Pros:** Simplest. No retry state.
- **Cons:** A transient blip forces the user to re-upload up to 10GB. Worker crashes leave jobs unresolved unless stall detection is added anyway.

**Recommendation:** **Option B**. Retries cover transient errors, the permanent/transient split avoids pointless retries, and the reconciliation sweep is the single mechanism that also covers TD-01's dual-write gap and TD-08's missed-callback case. Keep the storage lifecycle rule as defense in depth for orphan parts.

**Decision:** B (queue retries with backoff + `UnrecoverableError` for permanent errors + repeatable reconciliation sweep job; storage lifecycle rule as defense in depth)
**Libraries:** bullmq

**Note (reconciliation sweep and abandoned uploads, AMB-5):** The reconciliation sweep is a BullMQ job scheduler (`queue.upsertJobScheduler` with a stable scheduler id, so restarts do not duplicate it) that runs every **15 minutes**. Each run handles two cases:
- **Abandoned drafts:** a video still in `status = draft` **24 hours** after creation is abandoned. The sweep aborts its multipart upload (`AbortMultipartUpload`, which discards the stored parts; `NoSuchUpload` counts as already aborted) and sets `status = failed` with failure reason `upload_abandoned`. The row is **kept, not deleted**, so the owner can see what happened. The transition is a conditional update (`WHERE status = 'draft'`), so it cannot overwrite a completion that lands at the same time. See the TD-10 Note for the `draft → failed` transition.
- **Stuck processing:** a video in `status = processing` for more than **1 hour** is re-enqueued with the idempotent `jobId = videoId`, so a job that is still queued or running is not duplicated. This covers TD-01's dual-write gap and TD-08's missed enqueue. BullMQ ignores an `add` whose `jobId` still exists in Redis, so finished processing jobs must be removed (`removeOnComplete` / `removeOnFail`) for a re-enqueue to take effect.

The storage lifecycle rule (`AbortIncompleteMultipartUpload`) stays as defense in depth for orphan parts.

---

## TD-14: Unique Public Video Identifier (short URL slug)

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, unique URL that never conflicts ("Pontos de Atenção": "URL curta e única"). Unlisted videos (Phase 05) will be reachable only via the link, so the identifier must not be guessable or enumerable. This is cross-layer because the identifier format appears in API paths and responses, and frontend routes will be built on it. The internal primary key stays UUID, consistent with existing entities.

**Options:**

### Option A: Random short ID (YouTube-style), unique index + retry on collision
- 11-character base64url string from 64 random bits (`crypto.randomBytes(8)`), assigned when the draft is created and stored in a `UNIQUE` column. A collision on insert triggers a regenerate-and-retry.
- **Pros:** Short. Unguessable and non-enumerable, which suits unlisted videos. No dependency (`node:crypto`). Stable from draft creation onward. Collision probability is negligible, and the DB constraint makes uniqueness absolute.
- **Cons:** Needs a retry path (trivial). Random IDs carry no ordering.

### Option B: Encoded sequential ID (Sqids/Hashids over a `bigserial`)
- A reversible encoding of an incrementing integer.
- **Pros:** Collision-free by construction. Very short for early IDs.
- **Cons:** Decodable and enumerable, so it leaks volume and ordering and lets unlisted videos be discovered by walking IDs. The encoding alphabet and salt become a permanent contract. Adds a dependency.

### Option C: Expose a UUID (v4/v7) in the URL
- Use the UUID primary key (or a second UUID) as the public ID.
- **Pros:** Zero extra machinery. Collision-free in practice.
- **Cons:** 36 characters, which fails the "URL curta" requirement. UUIDv7 also leaks the creation timestamp.

**Recommendation:** **Option A**. It is the only option that is both short and safe for unlisted videos, needs no dependency, and relies on the database for absolute uniqueness.

**Decision:** A (random 11-char base64url slug from `crypto.randomBytes(8)`, `UNIQUE` column, retry on collision)
**Libraries:** —

---

## TD-15: Streaming and Download Delivery

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Playback must start without downloading the whole file, which means HTTP Range requests answered with `206 Partial Content`. Downloads must save the file. The diagram shows "Frontend → Object Storage: Streams". Under Strict BFF, any byte stream through the API would also cross the Next BFF. Access must be gateable (drafts and failed videos now, unlisted rules in Phase 05). This is cross-layer because it decides what the frontend's `<video src>` and download link point to. Depends on TD-03, TD-05, TD-06 and TD-09.

**Options:**

### Option A: Private bucket + short-lived presigned GET URLs issued by the API
- The API checks access and returns, or redirects (302) to, a presigned GET for streaming. Downloads use a separate presigned GET with `ResponseContentDisposition: attachment; filename="…"`. Storage serves Range/206 natively. Thumbnails use the same mechanism.
- **Pros:** Bytes flow directly from storage (later a CDN) to the browser, with no API/BFF bandwidth. Range/206 is handled correctly by S3 and MinIO with no custom code. Per-request access control. The download is the same mechanism with one extra parameter.
- **Cons:** URLs expire. The TTL must outlive a viewing session, or the player must refresh the URL, because seeking after expiry returns 403. URLs can be shared until they expire. Each listing needs signed thumbnail URLs (cheap, local HMAC).

### Option B: Public-read storage for ready videos, with static URLs
- `ready` objects live under a public-read prefix or bucket, served by plain URL (CDN-friendly). Drafts stay private.
- **Pros:** Simplest client URLs, maximally cacheable, no expiry.
- **Cons:** No access control: unlisted videos are protected only by URL obscurity, and revoking access requires moving objects. A visibility change means a server-side copy of up to 10GB (multipart copy above 5 GiB) or a per-prefix policy change.

### Option C: API-proxied streaming endpoint implementing Range → 206
- Nest parses `Range`, calls `GetObject` with `Range`, and pipes a `206` with `Content-Range`. Downloads work the same way with `Content-Disposition`.
- **Pros:** Full control: auth on every byte range and stable URLs that never expire. Storage stays fully private with no public endpoint.
- **Cons:** All video bandwidth crosses the API, and under Strict BFF also the Next BFF, which contradicts "sem impacto na performance". Range parsing and edge cases (multi-range, `If-Range`) must be hand-built. This is the costliest option to scale.

**Recommendation:** **Option A**. It delivers native Range/206 from storage without consuming API or BFF bandwidth, keeps per-request access control for drafts and future unlisted rules, and covers downloads with the same primitive. Choose a TTL that outlives a typical viewing session.

**Decision:** A (private bucket + short-lived presigned GET) — the API answers with a `302` redirect to the presigned URL. Downloads use `ResponseContentDisposition: attachment`. Storage serves Range/`206` natively.
**Libraries:** —

**Note (access rules, AMB-4):** In Phase 03 every video is still an unpublished draft. Streaming, download and thumbnail access are therefore limited to the authenticated **owner**, and only when `status = ready`:
- non-ready video → conflict error;
- non-owner or missing video → `404` not-found (existence is not leaked).

Anonymous access and public/unlisted visibility rules are deferred to Phase 04/05 (project-plan: Fase 04 visibility; Fase 05 anonymous access and the download button).

**Note (owner read, AMB-6):** Phase 03 adds a minimal **owner-only read of a single video**, so a client can follow processing and get the video's unique identifier. It returns:
- `id` and `slug` (TD-14), from which the unique video URL is built;
- `status` and the failure reason (set when `failed`);
- the processing metadata from the TD-11 Note (`duration`, `width`, `height`, actual `size`, jsonb `metadata`), null until processing finishes;
- whether a thumbnail is available (the thumbnail itself is served through the thumbnail access above).

The read works in every status, not only `ready`. A non-owner or missing video returns `404`, as above. Listing and managing the channel's videos stays in Phase 04.

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Message Queue Technology | BullMQ on Redis (`@nestjs/bullmq`) | A |
| TD-02 | Backend | Video Worker Runtime Topology | Same codebase, separate entrypoint + Compose service | A |
| TD-03 | Backend | S3 Client Library | AWS SDK v3 (`client-s3` + `s3-request-presigner`) | A |
| TD-04 | Repo-wide | Local S3-Compatible Image Sourcing (MinIO) | Pin last official `quay.io/minio/minio` tag (fork as fallback) | B (fork `pgsty/minio`; diverges) |
| TD-05 | Backend | Storage Endpoint Topology for Presigned URLs | Dual endpoint (`S3_ENDPOINT` internal + `S3_PUBLIC_ENDPOINT`) | A |
| TD-06 | Backend | Bucket and Object Key Layout | Single private bucket, `videos/{videoId}/…` | A |
| TD-07 | Cross-layer | Large Upload Protocol | S3 multipart with presigned part URLs, API-orchestrated | A |
| TD-08 | Backend | Upload Completion Detection and Processing Trigger | API-driven completion endpoint | A |
| TD-09 | Backend | Accepted Input Formats and Playback Compatibility | Allowlist browser-playable formats, validated at API + worker | A |
| TD-10 | Backend | Video Status Lifecycle Model | Two orthogonal fields (processing + publication) | A (single enum; diverges) |
| TD-11 | Backend | FFmpeg/ffprobe Integration Approach | Distro FFmpeg in worker image + thin `child_process` wrapper | A |
| TD-12 | Backend | Worker Access to the Source Video | Ranged remote read via presigned GET | A |
| TD-13 | Backend | Processing Failure, Retry, and Abandoned-Upload Cleanup | Queue retries + permanent/transient split + reconciliation sweep | B |
| TD-14 | Cross-layer | Unique Public Video Identifier | Random 11-char base64url slug + unique index | A |
| TD-15 | Cross-layer | Streaming and Download Delivery | Private bucket + presigned GET (Range/206 native) | A |
