# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 1/20 completed

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
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.3 — DatabaseModule e opções de ConfigModule compartilhadas entre API e worker
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.4 — StorageModule: clientes S3 interno/público, multipart e URLs pré-assinadas
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.5 — QueueModule e fila `video-processing` (contratos + producer)
- **Status:** pending
- **Tests:** —
- **Observations:** none

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
