---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-10-15T13:27:03-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-15T14:18:05-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-15T13:28:45-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-10-15T13:28:45-03:00"
  docs/phases/phase-02-auth/context.md: "2026-10-15T13:28:45-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-10-15T13:28:45-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-10-15T13:27:02-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified._

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** _None named explicitly for this phase in project-plan.md._

**Deferred subprojects:** _None._

**Sequencing notes:** "> Depende de: Fase 01, Fase 02". Intro sentence: "Upload de arquivos grandes sem travar o sistema, processamento automático do vídeo e geração de URL única."

**Neighbors (for boundary detection only):**

- **Phase 02:** Cadastro, Login e Gerenciamento de Conta (Depende de: Fase 01)
- **Phase 04:** Gerenciamento de Vídeos e Canal (Depende de: Fase 02, Fase 03)

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Message Queue Technology | decided | A (BullMQ on Redis via `@nestjs/bullmq`) | @nestjs/bullmq, bullmq, ioredis |
| phase-03-videos/TD-02 | phase | Backend | Video Worker Runtime Topology | decided | A (same codebase, separate worker entrypoint + `video-worker` service) | — |
| phase-03-videos/TD-03 | phase | Backend | S3 Client Library | decided | A (AWS SDK v3) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-04 | phase | Repo-wide | Local S3-Compatible Image Sourcing (MinIO) | decided | B (fork `pgsty/minio`; diverges from Recommendation) | — |
| phase-03-videos/TD-05 | phase | Backend | Storage Endpoint Topology for Presigned URLs | decided | A (two endpoints: `S3_ENDPOINT` + `S3_PUBLIC_ENDPOINT`) | — |
| phase-03-videos/TD-06 | phase | Backend | Bucket and Object Key Layout | decided | A (one private bucket, `videos/{videoId}/…`) | — |
| phase-03-videos/TD-07 | phase | Cross-layer | Large Upload Protocol (10GB, resumable, not proxied) | decided | A (S3 multipart with presigned part URLs) | — |
| phase-03-videos/TD-08 | phase | Backend | Upload Completion Detection and Processing Trigger | decided | A (completion endpoint on the API) | — |
| phase-03-videos/TD-09 | phase | Backend | Accepted Input Formats and Playback Compatibility | decided | A (allowlist of browser-playable formats) | — |
| phase-03-videos/TD-10 | phase | Backend | Video Status Lifecycle Model | decided | A (one `status` enum: draft→processing→ready/failed; diverges from Recommendation) | — |
| phase-03-videos/TD-11 | phase | Backend | FFmpeg/ffprobe Integration Approach | decided | A (distro ffmpeg/ffprobe + typed `child_process` wrapper) | — |
| phase-03-videos/TD-12 | phase | Backend | Worker Access to the Source Video | decided | A (ranged read through an internal presigned GET) | — |
| phase-03-videos/TD-13 | phase | Backend | Processing Failure, Retry, and Abandoned-Upload Cleanup | decided | B (retries + `UnrecoverableError` + reconciliation sweep) | bullmq |
| phase-03-videos/TD-14 | phase | Cross-layer | Unique Public Video Identifier (short URL slug) | decided | A (random 11-char base64url slug, UNIQUE) | — |
| phase-03-videos/TD-15 | phase | Cross-layer | Streaming and Download Delivery | decided | A (private bucket + short-lived presigned GET, 302) | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03, phase-03-videos/TD-04, phase-03-videos/TD-05, phase-03-videos/TD-06 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-02, phase-03-videos/TD-13 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-05, phase-03-videos/TD-07, phase-03-videos/TD-09, phase-03-videos/TD-13 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-07, phase-03-videos/TD-10 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-02, phase-03-videos/TD-08, phase-03-videos/TD-10, phase-03-videos/TD-11, phase-03-videos/TD-12, phase-03-videos/TD-13 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-11, phase-03-videos/TD-12 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-14 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-05, phase-03-videos/TD-09, phase-03-videos/TD-15 |
| Download do vídeo pelo usuário | phase-03-videos/TD-15 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** It is the NestJS-documented queue integration. It provides the stalled-job recovery that long FFmpeg runs need, and a Redis container is a small operational cost in a Compose-only environment. pg-boss is a close second and wins if avoiding new infrastructure matters more than first-party Nest integration, because its transactional enqueue removes the dual-write concern.
**Libraries:** @nestjs/bullmq, bullmq, ioredis

**Note:** Exact pins checked on 2026-10-15: `@nestjs/bullmq@12.0.0` (peers: `@nestjs/common`/`@nestjs/core` `^10 || ^11 || ^12`, `bullmq` `^3 … ^6`, compatible with the installed `@nestjs/core` 11.1.16), `bullmq@6.3.15`, `ioredis@6.0.0`. Since BullMQ 6, `ioredis` is an optional peer dependency that must be installed explicitly; ioredis 6 requires Node ≥ 20 and defaults to RESP3. Redis runs as a `redis` Compose service (`redis:8.10.2-alpine`) with `maxmemory-policy noeviction`; the API and worker reach it by its service name.

### phase-03-videos/TD-02

**Recommendation:** Running in a separate container satisfies the architecture and the performance requirement, and sharing the codebase avoids duplicating the persistence layer in a repo with no shared-package tooling.
**Libraries:** —

**Note:** In dev, `nestjs-api` and `video-worker` share the `Dockerfile.dev` image (`node:25.6.0-slim`, Debian 12 bookworm), and FFmpeg is installed in that image (`apt install ffmpeg`; Debian candidate `7:5.1.9-0+deb12u1`). Reason: the full Jest suite (unit + integration + e2e) runs inside the `nestjs-api` container, and the worker integration tests need real `ffprobe`/`ffmpeg` and generate fixture clips with ffmpeg's `lavfi` `testsrc`. This overrides the option's "worker image adds FFmpeg" wording for the dev image. Splitting the API and worker images for production stays possible later.

### phase-03-videos/TD-03

**Recommendation:** Production is AWS S3, so its official SDK minimizes dev/prod divergence, and it presigns every operation TD-07 and TD-15 need.
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

**Note:** Exact pins checked on 2026-10-15: `@aws-sdk/client-s3@3.1152.0` and `@aws-sdk/s3-request-presigner@3.1152.0`. Both are always upgraded together (Node ≥ 20 engine).

### phase-03-videos/TD-04

**Recommendation:** Pin the last official image, with Option B as the fallback. MinIO is only a local stand-in for production S3, so a pinned official image is the lowest-risk choice for a dev fixture. If the Quay tag becomes unavailable, switch to the fork, which is a one-line `image:` change because env vars and data format are identical.
**Libraries:** —

**Note:** The decision deliberately diverges from the Recommendation. On 2026-10-15, `docker manifest inspect` and `docker pull` showed that `minio/minio` and `quay.io/minio/minio` (including `RELEASE.2025-09-07T16-13-09Z` and `latest`), and `minio/mc` / `quay.io/minio/mc`, can no longer be pulled ("unauthorized" / "repository does not exist"). Pins: `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` (verified `minio version RELEASE.2026-08-04T00-00-00Z`) for the `minio` Compose service. Bucket bootstrap uses `pgsty/mc:RELEASE.2026-09-16T00-00-00Z`, or the AWS SDK if simpler; `/plan-build` makes that choice.

### phase-03-videos/TD-05

**Recommendation:** It solves the signing problem with one env key and no new infrastructure, while every server-to-server connection keeps the Compose service name. `host.docker.internal` is not offered because it conflicts with the project's Docker networking rule.
**Libraries:** —

**Note:** Integration and e2e tests run inside the `nestjs-api` container, which cannot reach `localhost:9000`. The test environment therefore sets `S3_PUBLIC_ENDPOINT=http://minio:9000` (equal to the internal endpoint), so tests can `PUT`/`GET` presigned URLs for real.

### phase-03-videos/TD-06

**Recommendation:** One private bucket with per-video prefixes keeps bootstrap, CORS, lifecycle and deletion trivial. Storage-growth planning is better served by persisting `size_bytes` per video than by encoding owners in keys.
**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** It is the only option where the data plane bypasses both the API and the BFF, as the Strict BFF decision anticipated for video payloads. It also resumes natively and needs no new service. The handshake cost is a few small JSON endpoints.
**Libraries:** —

**Note:** The maximum size is 10 GiB (`10 * 1024^3` = 10,737,418,240 bytes). It is validated against the declared size at initiation (`POST /videos`) and checked again against the actual stored size at completion. The API fixes the part size at 64 MiB (67,108,864 bytes), with a smaller last part, so a 10 GiB upload has at most 160 parts.

### phase-03-videos/TD-08

**Recommendation:** Under TD-07 Option A the API already performs `CompleteMultipartUpload`, so it is the natural, environment-independent place to transition status and enqueue. The rare missing-callback case is covered by TD-13's reconciliation instead of a second event pipeline.
**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** It guarantees that "ready" means "playable" without adding transcoding, which the phase does not ask for. Option B is a natural future extension if format breadth becomes a requirement.
**Libraries:** —

**Note:** The allowlist is `video/mp4` (`.mp4`: H.264 video; AAC or MP3 audio, or no audio) and `video/webm` (`.webm`: VP8, VP9 or AV1 video; Opus or Vorbis audio, or no audio). The API checks the declared MIME type and extension at initiation. The worker confirms the real container and codecs with ffprobe, and on a mismatch sets the video to `failed` with a machine-readable reason.

### phase-03-videos/TD-10

**Recommendation:** It keeps Phase 03's processing lifecycle stable when Phase 04 introduces publication, and keeps a clear owner per transition, in line with the project's single-responsibility principle. Option A forces Phase 04 to reshape a contract that the frontend already consumes.
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

### phase-03-videos/TD-11

**Recommendation:** Two well-defined commands do not justify a wrapper library, `fluent-ffmpeg` is deprecated, and installing FFmpeg only in the worker image keeps it out of the API (consistent with TD-02).
**Libraries:** —

**Note:** FFmpeg comes from Debian 12's `ffmpeg` apt package (5.1.x) in the shared dev image, per the TD-02 Note. It is not an npm dependency. The "FFmpeg only in the worker image" wording of the Recommendation does not apply to the dev image.

**Note (processing outputs, AMB-3):**
- **Typed columns:** `duration` (seconds, numeric), `width`, `height`, and actual `size` in bytes.
- **jsonb `metadata` column:** video codec, audio codec (nullable), container/format name, bit rate, and frame rate.
- **Thumbnail:** one JPEG frame taken at 10% of the duration (0 s for clips shorter than 1 s), scaled to a maximum width of 1280 px with the aspect ratio kept, stored at key `videos/{videoId}/thumbnail.jpg`.

### phase-03-videos/TD-12

**Recommendation:** Both required operations need only a small, seekable fraction of the file, and ranged reads avoid moving 10GB per job. Option B remains a reasonable fallback inside the job when a ranged read fails for non-network reasons.
**Libraries:** —

### phase-03-videos/TD-13

**Recommendation:** Retries cover transient errors, the permanent/transient split avoids pointless retries, and the reconciliation sweep is the single mechanism that also covers TD-01's dual-write gap and TD-08's missed-callback case. Keep the storage lifecycle rule as defense in depth for orphan parts.
**Libraries:** bullmq

**Note (reconciliation sweep and abandoned uploads, AMB-5):** The reconciliation sweep is a BullMQ job scheduler (`queue.upsertJobScheduler` with a stable scheduler id, so restarts do not duplicate it) that runs every **15 minutes**. Each run handles two cases:
- **Abandoned drafts:** a video still in `status = draft` **24 hours** after creation is abandoned. The sweep aborts its multipart upload (`AbortMultipartUpload`, which discards the stored parts; `NoSuchUpload` counts as already aborted) and sets `status = failed` with failure reason `upload_abandoned`. The row is **kept, not deleted**, so the owner can see what happened. The transition is a conditional update (`WHERE status = 'draft'`), so it cannot overwrite a completion that lands at the same time. See the TD-10 Note for the `draft → failed` transition.
- **Stuck processing:** a video in `status = processing` for more than **1 hour** is re-enqueued with the idempotent `jobId = videoId`, so a job that is still queued or running is not duplicated. This covers TD-01's dual-write gap and TD-08's missed enqueue. BullMQ ignores an `add` whose `jobId` still exists in Redis, so finished processing jobs must be removed (`removeOnComplete` / `removeOnFail`) for a re-enqueue to take effect.

The storage lifecycle rule (`AbortIncompleteMultipartUpload`) stays as defense in depth for orphan parts.

### phase-03-videos/TD-14

**Recommendation:** It is the only option that is both short and safe for unlisted videos, needs no dependency, and relies on the database for absolute uniqueness.
**Libraries:** —

### phase-03-videos/TD-15

**Recommendation:** It delivers native Range/206 from storage without consuming API or BFF bandwidth, keeps per-request access control for drafts and future unlisted rules, and covers downloads with the same primitive. Choose a TTL that outlives a typical viewing session.
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

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.

**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority — Auth.js's value (DB adapters, OAuth providers, magic-link, `getServerSession` helpers) is mostly unused in this configuration. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern; a misconfigured Auth.js callback is a longer fault-isolation loop. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use; Auth.js v5 versions track Next.js majors with a lag, adding compatibility risk that Option A does not have. Option C is rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive (loses RSC personalization).
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; the marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout (one `session.destroy()` call) and avoids the orphan-cookie failure mode of Option A. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome (avatar, channel name) without a per-render `/auth/me` round-trip — Phase 04+ gains compound here. Option A is a viable downgrade if the team rejects `iron-session` for any reason; the migration A→B (or B→A) is a one-Route-Handler refactor with no test changes downstream because the BFF interface is unchanged. Option C is rejected: it solves a problem (server-side revocation) the project does not have at the cost of infrastructure the project does not own.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh) — adopting B means doing both. Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving and force a `"use client"` shell near the root.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions; the form code does not change if TD-05 is revisited later. (2) **Aligned with shadcn's canonical form primitive** — the project already commits to `radix-nova` shadcn (`components.json`); `npx shadcn@latest add form` produces react-hook-form wrappers; choosing react-hook-form means using the supported primitive instead of hand-rolling around it. (3) **Zod-first developer ergonomics match the rest of the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms with zero new validator paradigm. Option B is rejected for impedance with shadcn's primitive and for over-investing in progressive-enhancement that the strict-BFF model does not require. Option C is rejected for the per-field boilerplate and the loss of client-side feedback on a project that values quick, type-safe form iteration.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** — `next-frontend/CLAUDE.md` § Testing and `next-frontend-msw-foundation` were authored for Route-Handlers-as-functions; Option A reuses them with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking when the cost of inconsistency compounds (Option C). Option B has real ergonomic appeal for the simplest forms but fragments the BFF surface and forces test-pattern reinvention; if the team later wants progressive enhancement for specific forms, the migration A→B is per-form and doesn't require touching unrelated routes — A is the safer default and the cheaper baseline.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML; the Client Provider hydrates with the correct initial state; users never see "Login" briefly turn into their avatar. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it; the BFF surface stays minimal. The `router.refresh()` requirement after mid-session mutations is a small price (one line in the relevant mutation handler) for the structural benefits. Option B is rejected for the double-read-and-flicker; Option C is dominated by Option B and rejected.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** — confirmation is RSC-only; reset is RSC + Client form (TD-04, TD-05 patterns reused) — both share the "RSC owns the token, Client Component owns the input" split. (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level (a small note for `/plan-build` to confirm; not a separate TD). Option B's Route-Handler-as-link-target adds redirects for no clean gain. Option C is dominated.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** **Option A (`@nestjs/swagger`)** — é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.

**Libraries:** @nestjs/swagger

**Revisions:**

- 2026-05-12 — Esclarece que o CLI plugin (`classValidatorShim: true`) cobre apenas inferência de schemas de DTOs a partir de `class-validator`; documentação de operações, respostas tipadas por status code, contratos de erro (alinhados ao envelope de phase-02-auth/TD-07) e exemplos exigem decoradores explícitos (`@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiExtraModels`). _Rationale:_ openapi.json gerado pelo bootstrap atual está genérico — sem detalhes de parâmetros, schemas de retorno por status, nem contratos de erro — porque a base instalada se apoiou só na introspecção automática. Esta revisão fixa que enriquecimento via decoradores explícitos faz parte da Option A escolhida, não é trabalho fora do escopo do TD.

### openapi-docs-nestjs/TD-02

**Recommendation:** **Option C (Ambos)** — o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.

**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** **Option B (Apenas em dev/staging)** — alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.

**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: ...` _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function... _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and... _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options... _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. Documented as a known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per Non-UI rows above. The 3 ship-this-phase telas (signup, login, forgot-password) are inventoried and covered by their own verbs; the umbrella bullet itself is deferred to the phase that lands the missing screens. |

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|-----------|--------|-----------|---------|
| "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance" (UI: upload screen / progress) | deferred | deferred_to_next_phase — this slice is backend-only; the phase brief puts the video UI out of scope, and a future Phase 03 frontend slice or a later phase delivers it. Backend delivery (initiate → presigned parts → resume → complete) is verified through API/E2E tests. | phase-03-videos/TD-05, phase-03-videos/TD-07, phase-03-videos/TD-08, phase-03-videos/TD-09 |
| "Reprodução via streaming (sem necessidade de download completo)" (UI: player) | deferred | deferred_to_next_phase — this slice is backend-only; the phase brief puts the video UI out of scope, and a future Phase 03 frontend slice or a later phase delivers it. Backend delivery (owner-only 302 → presigned GET with Range/206) is verified through API/E2E tests. | phase-03-videos/TD-05, phase-03-videos/TD-09, phase-03-videos/TD-15 |
| "Download do vídeo pelo usuário" (UI: download action) | deferred | deferred_to_next_phase — this slice is backend-only; the phase brief puts the video UI out of scope, and a future Phase 03 frontend slice or a later phase delivers it (project-plan: Fase 05 download button). Backend delivery (owner-only 302 → presigned GET with `Content-Disposition: attachment`) is verified through API/E2E tests. | phase-03-videos/TD-15 |

## Testing Requirements

_(from `testing-guide-nestjs-project` § 3 Feature Implementation Checklist)_

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |

_Artifact types not yet in the project (e.g., queue processors / worker consumers) are covered by `testing-guide-nestjs-project/artifacts/future-types.md`; external-system strategies (storage, queue) by `references/external-systems.md`._
