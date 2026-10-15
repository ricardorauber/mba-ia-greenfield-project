---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-15T14:18:42-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-15T14:18:05-03:00"
issues:
  - id: AMB-1
    status: resolved
    summary: "UI side of streaming/download/upload neither inventoried, deferred, nor Non-UI"
    resolved_by: deferred_capability
  - id: AMB-2
    status: resolved
    summary: "Draft pre-registration: owner (user vs channel) and initial fields undefined"
    resolved_by: phase-03-videos/TD-10
  - id: AMB-3
    status: resolved
    summary: "Processing outputs unspecified: which metadata fields, which thumbnail frame"
    resolved_by: phase-03-videos/TD-11
  - id: AMB-4
    status: resolved
    summary: "Stream/download access rules by viewer and video status undefined vs Phase 04"
    resolved_by: phase-03-videos/TD-15
  - id: AMB-5
    status: resolved
    summary: "Abandoned draft uploads: threshold and terminal outcome (failed vs delete) undefined"
    resolved_by: phase-03-videos/TD-13
  - id: AMB-6
    status: resolved
    summary: "Owner read of video status/metadata/slug: Phase 03 endpoint or Phase 04?"
    resolved_by: phase-03-videos/TD-15
  - id: OQ-1
    status: resolved
    summary: "TD-01 pending — Message Queue Technology"
    resolved_by: phase-03-videos/TD-01
  - id: OQ-2
    status: resolved
    summary: "TD-02 pending — Video Worker Runtime Topology"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-3
    status: resolved
    summary: "TD-03 pending — S3 Client Library"
    resolved_by: phase-03-videos/TD-03
  - id: OQ-4
    status: resolved
    summary: "TD-04 pending — Local S3-Compatible Image Sourcing (MinIO)"
    resolved_by: phase-03-videos/TD-04
  - id: OQ-5
    status: resolved
    summary: "TD-05 pending — Storage Endpoint Topology for Presigned URLs"
    resolved_by: phase-03-videos/TD-05
  - id: OQ-6
    status: resolved
    summary: "TD-06 pending — Bucket and Object Key Layout"
    resolved_by: phase-03-videos/TD-06
  - id: OQ-7
    status: resolved
    summary: "TD-07 pending — Large Upload Protocol (10GB, resumable, not proxied)"
    resolved_by: phase-03-videos/TD-07
  - id: OQ-8
    status: resolved
    summary: "TD-08 pending — Upload Completion Detection and Processing Trigger"
    resolved_by: phase-03-videos/TD-08
  - id: OQ-9
    status: resolved
    summary: "TD-09 pending — Accepted Input Formats and Playback Compatibility"
    resolved_by: phase-03-videos/TD-09
  - id: OQ-10
    status: resolved
    summary: "TD-10 pending — Video Status Lifecycle Model"
    resolved_by: phase-03-videos/TD-10
  - id: OQ-11
    status: resolved
    summary: "TD-11 pending — FFmpeg/ffprobe Integration Approach"
    resolved_by: phase-03-videos/TD-11
  - id: OQ-12
    status: resolved
    summary: "TD-12 pending — Worker Access to the Source Video"
    resolved_by: phase-03-videos/TD-12
  - id: OQ-13
    status: resolved
    summary: "TD-13 pending — Processing Failure, Retry, and Abandoned-Upload Cleanup"
    resolved_by: phase-03-videos/TD-13
  - id: OQ-14
    status: resolved
    summary: "TD-14 pending — Unique Public Video Identifier (short URL slug)"
    resolved_by: phase-03-videos/TD-14
  - id: OQ-15
    status: resolved
    summary: "TD-15 pending — Streaming and Download Delivery"
    resolved_by: phase-03-videos/TD-15
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._ _(No `## UI Inventory` in context.md, so the UI coverage check does not apply. This slice is backend-only; see AMB-1.)_

## Resolved Issues

- **AMB-1** — The UI side of upload, streaming and download was neither inventoried, deferred nor marked Non-UI. Resolved with choice (a): this slice is backend-only. The UI-facing aspects of the upload, playback and download bullets are recorded as `deferred` rows in context.md `## Non-UI / Deferred Capabilities`. Rationale: deferred_to_next_phase — the phase brief puts the video UI out of scope, and a future Phase 03 frontend slice or a later phase delivers it. Backend delivery is verified through API/E2E tests. `resolved_by: deferred_capability`.
- **AMB-2** — Draft pre-registration owner and initial fields were undefined. Clarified as a Note on TD-10:
  - The video belongs to the uploader's channel (`videos.channel_id` FK → `channels`, 1:1 with the user). Ownership is checked through the authenticated user's channel.
  - Initial fields: `title` (optional, client-supplied; defaults to the original file name without its extension), the original file name, the declared MIME type, and the declared size in bytes.
  - Description, visibility and category are not part of Phase 03. Editing video information belongs to Phase 04.

  `resolved_by: phase-03-videos/TD-10`.
- **AMB-3** — Processing outputs were unspecified. Clarified as a Note on TD-11:
  - Typed columns: `duration` (seconds, numeric), `width`, `height`, and actual `size` in bytes.
  - jsonb `metadata` column: video codec, audio codec (nullable), container/format name, bit rate, and frame rate.
  - Thumbnail: one JPEG frame at 10% of the duration (0 s when shorter than 1 s), maximum width 1280 px with the aspect ratio kept, key `videos/{videoId}/thumbnail.jpg`.

  `resolved_by: phase-03-videos/TD-11`.
- **AMB-4** — Stream and download access rules were undefined. Clarified as a Note on TD-15:
  - In Phase 03, streaming, download and thumbnail access are limited to the authenticated owner, and only when `status = ready`.
  - A non-ready video returns a conflict error. A non-owner or missing video returns `404` not-found, so existence is not leaked.
  - Anonymous access and public/unlisted visibility are deferred to Phase 04/05.

  `resolved_by: phase-03-videos/TD-15`.
- **AMB-5** — Abandoned draft uploads had no threshold or terminal outcome. Clarified as a Note on TD-13, cross-referenced from a Note on TD-10:
  - The reconciliation sweep is a BullMQ job scheduler that runs every 15 minutes.
  - A video still in `draft` 24 hours after creation is abandoned. The sweep aborts its multipart upload (stored parts are discarded) and sets `failed` with failure reason `upload_abandoned`. The row is kept, not deleted. This adds the `draft → failed` transition to TD-10's lifecycle.
  - The same sweep re-enqueues videos stuck in `processing` for more than 1 hour, using the idempotent `jobId = videoId`.

  `resolved_by: phase-03-videos/TD-13`.
- **AMB-6** — It was unclear which phase owns the owner's read of a single video. Resolved with choice (a), recorded as a Note on TD-15 and cross-referenced from a Note on TD-10:
  - Phase 03 adds a minimal owner-only read of a single video. It returns id, slug (TD-14), status, failure reason, the processing metadata from the TD-11 Note, and whether a thumbnail is available.
  - It works in every status. A non-owner or missing video returns `404`.
  - Listing and managing the channel's videos stays in Phase 04.

  `resolved_by: phase-03-videos/TD-15`.
- **OQ-1** — TD-01 → A (BullMQ on Redis via `@nestjs/bullmq`); pins `@nestjs/bullmq@12.0.0`, `bullmq@6.3.15`, `ioredis@6.0.0`. `resolved_by: phase-03-videos/TD-01`.
- **OQ-2** — TD-02 → A (same codebase, separate worker entrypoint + `video-worker` Compose service). FFmpeg is installed in the shared `Dockerfile.dev` image because the full Jest suite runs in `nestjs-api`. `resolved_by: phase-03-videos/TD-02`.
- **OQ-3** — TD-03 → A (AWS SDK v3; `@aws-sdk/client-s3@3.1152.0` + `@aws-sdk/s3-request-presigner@3.1152.0`). `resolved_by: phase-03-videos/TD-03`.
- **OQ-4** — TD-04 → B (fork `pgsty/minio:RELEASE.2026-08-04T00-00-00Z`, plus `pgsty/mc:RELEASE.2026-09-16T00-00-00Z` or AWS SDK bootstrap). This diverges from the Recommendation because the official images can no longer be pulled (verified 2026-10-15). `resolved_by: phase-03-videos/TD-04`.
- **OQ-5** — TD-05 → A (dual endpoint). The test environment sets `S3_PUBLIC_ENDPOINT=http://minio:9000`. `resolved_by: phase-03-videos/TD-05`.
- **OQ-6** — TD-06 → A (single private bucket, `videos/{videoId}/…`). `resolved_by: phase-03-videos/TD-06`.
- **OQ-7** — TD-07 → A (S3 multipart with presigned part URLs). The 10 GiB maximum is validated at initiation and again at completion; parts are a fixed 64 MiB. `resolved_by: phase-03-videos/TD-07`.
- **OQ-8** — TD-08 → A (API-driven completion endpoint). `resolved_by: phase-03-videos/TD-08`.
- **OQ-9** — TD-09 → A (allowlist: `video/mp4` H.264 + AAC/MP3/none; `video/webm` VP8/VP9/AV1 + Opus/Vorbis/none; validated at the API and in the worker). `resolved_by: phase-03-videos/TD-09`.
- **OQ-10** — TD-10 → A (single enum `draft → processing → ready | failed`, with a failure reason). This diverges from the Recommendation to follow the brief literally. `resolved_by: phase-03-videos/TD-10`.
- **OQ-11** — TD-11 → A (distro `ffmpeg`/`ffprobe` + thin `child_process` wrapper). `resolved_by: phase-03-videos/TD-11`.
- **OQ-12** — TD-12 → A (ranged read from an internally-presigned GET URL). `resolved_by: phase-03-videos/TD-12`.
- **OQ-13** — TD-13 → B (retries + `UnrecoverableError` + repeatable reconciliation sweep, with the storage lifecycle rule as defense in depth). `resolved_by: phase-03-videos/TD-13`.
- **OQ-14** — TD-14 → A (random 11-char base64url slug, `UNIQUE` column, retry on collision). `resolved_by: phase-03-videos/TD-14`.
- **OQ-15** — TD-15 → A (private bucket + presigned GET via `302` redirect; download with `ResponseContentDisposition: attachment`). `resolved_by: phase-03-videos/TD-15`.
