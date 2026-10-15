---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.12
target_file: test/videos-upload-complete.e2e-spec.ts
---

# POST /videos/:id/upload/complete — Test Plan

## Application Overview

`POST /videos/:id/upload/complete` conclui o multipart upload no storage (`ListParts` → `CompleteMultipartUpload` com os ETags em ordem → `HeadObject` para validar o tamanho real contra o declarado), move o vídeo de `draft` para `processing` e enfileira o job `process-video` (`jobId = videoId`) na fila `video-processing` — o gatilho único entre upload e worker. É idempotente: com o vídeo já em `processing`/`ready` devolve `200` com o estado atual sem efeitos colaterais; em `failed` retorna `409 INVALID_VIDEO_STATUS`. Partes faltando retornam `409 UPLOAD_INCOMPLETE` mantendo o vídeo em `draft` para retomada. Falha de enqueue (Redis indisponível) não propaga — o sweep re-enfileira vídeos `processing` travados.

## Test Scenarios

### 1. Concluir o upload e disparar o processamento

**Setup:** `beforeAll` — `Test.createTestingModule({ imports: [AppModule] }).compile()` + `createNestApplication()` reproduzindo a config global de `main.ts` (`ValidationPipe({ whitelist, forbidNonWhitelisted, transform })`, `DomainExceptionFilter`, `ValidationExceptionFilter`), contra Postgres, MinIO e Redis reais (`QUEUE_PREFIX=streamtube-test` e `S3_PUBLIC_ENDPOINT=http://minio:9000` via `src/test/setup-test-env.ts`; a API só produz — nenhum consumer roda no grafo da API, então o job permanece na fila); a fila é obtida por `app.get(getQueueToken('video-processing'))`; `beforeEach` — `cleanAllTables(dataSource)` + `queue.obliterate({ force: true })` + dois usuários autenticados (dono e outro), cada um com canal, via `createAuthenticatedUser(app)` de `test/helpers/auth.helper.ts` (extraído em SI-03.8); o vídeo do dono é criado via `POST /videos` com `{ "file_name": "clip.mp4", "mime_type": "video/mp4", "size": 1048576 }` (`part_count: 1`) e a parte 1 (1048576 bytes) é enviada por `fetch` `PUT` na URL de `POST /videos/:id/upload/part-urls`; `afterAll` — `queue.obliterate({ force: true })`, `StorageService.deletePrefix(videoPrefix(id))` dos vídeos criados + `app.close()`.

#### 1.1. conclui-e-move-para-processing

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-15T17:40:45Z

**Steps:**
  1. POST /videos/:id/upload/complete com o token do dono, sem body
    - expect: HTTP `200` com `VideoResponseDto` e `status: "processing"`
  2. GET /videos/:id com o token do dono
    - expect: HTTP `200` com `status: "processing"`
    - expect: a linha em `videos` tem `processing_started_at` preenchido
    - expect: `HeadObject` em `videos/{id}/original` retorna `ContentLength = 1048576`

#### 1.2. job-process-video-enfileirado-com-job-id-do-video

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-15T17:40:45Z

**Steps:**
  1. POST /videos/:id/upload/complete com o token do dono
    - expect: HTTP `200`
  2. `queue.getJob(videoId)`
    - expect: o job existe, com `name = 'process-video'`, `id = videoId` e `data.videoId = videoId`

#### 1.3. segunda-conclusao-e-replay-idempotente

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-15T17:40:45Z

**Steps:**
  1. POST /videos/:id/upload/complete com o token do dono
    - expect: HTTP `200` com `status: "processing"`
  2. POST /videos/:id/upload/complete de novo, com o token do dono
    - expect: HTTP `200` com o status atual (`processing`)
    - expect: `queue.getJobCounts()` soma exatamente 1 job e `queue.getJob(videoId)` continua sendo o mesmo job

#### 1.4. redis-indisponivel-no-enqueue-ainda-conclui

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-15T17:40:45Z

**Steps:**
  1. `jest.spyOn(app.get(VideoProcessingProducer), 'enqueue').mockRejectedValueOnce(new Error('connect ECONNREFUSED redis:6379'))` (simula Redis fora no momento do enqueue)
    - expect: spy instalado
  2. POST /videos/:id/upload/complete com o token do dono
    - expect: HTTP `200` com `status: "processing"`
    - expect: a linha em `videos` está em `processing`
    - expect: nenhum job foi criado na fila (`queue.getJob(videoId)` retorna `undefined`)

### 2. Rejeitar conclusão inválida e não donos

**Setup:** mesmo bootstrap do grupo 1; nos cenários de parte faltando, o vídeo é criado com `size: 67108865` (`part_count: 2`) em vez do vídeo de uma parte.

#### 2.1. parte-faltando-retorna-upload-incomplete-e-mantem-draft

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-15T17:40:45Z

**Steps:**
  1. Criar o vídeo via `POST /videos` com `{ "file_name": "clip.mp4", "mime_type": "video/mp4", "size": 67108865 }`, pedir a URL só da parte 2 e enviar 1 byte por `fetch` `PUT`
    - expect: `PUT` responde `200` com `ETag`
  2. POST /videos/:id/upload/complete com o token do dono
    - expect: HTTP `409` com `error: "UPLOAD_INCOMPLETE"`
    - expect: GET /videos/:id retorna `status: "draft"`
  3. GET /videos/:id/upload com o token do dono
    - expect: HTTP `200` com `uploaded_parts` = `[{ part_number: 2, size: 1 }]` (o upload segue retomável)

#### 2.2. video-failed-retorna-invalid-video-status

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-15T17:40:45Z

**Steps:**
  1. Atualizar a linha do vídeo via repository para `status = 'failed'`, `failure_reason = 'abandoned_upload'`
    - expect: update aplicado
  2. POST /videos/:id/upload/complete com o token do dono
    - expect: HTTP `409` com `error: "INVALID_VIDEO_STATUS"`
    - expect: nenhum job foi criado na fila

#### 2.3. nao-dono-recebe-video-not-found

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-10-15T17:40:45Z

**Steps:**
  1. POST /videos/:id/upload/complete do vídeo do dono, com o token do outro usuário
    - expect: HTTP `404` com `error: "VIDEO_NOT_FOUND"`
    - expect: o vídeo do dono continua `draft` e nenhum job foi criado
