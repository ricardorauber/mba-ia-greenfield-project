---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.10
target_file: test/videos-upload-status.e2e-spec.ts
---

# GET /videos/:id/upload — Test Plan

## Application Overview

`GET /videos/:id/upload` permite ao cliente retomar um upload interrompido sem guardar estado próprio: o endpoint consulta o storage (`ListParts` do multipart aberto em `videos/{videoId}/original`) e devolve `part_size`, `part_count` (derivado do tamanho declarado) e as `uploaded_parts` já armazenadas, ordenadas por `part_number`. Só o dono acessa (não dono → `404 VIDEO_NOT_FOUND`) e somente com o vídeo em `draft` (senão `409 INVALID_VIDEO_STATUS`).

## Test Scenarios

### 1. Consultar o estado do upload para retomada

**Setup:** `beforeAll` — `Test.createTestingModule({ imports: [AppModule] }).compile()` + `createNestApplication()` reproduzindo a config global de `main.ts` (`ValidationPipe({ whitelist, forbidNonWhitelisted, transform })`, `DomainExceptionFilter`, `ValidationExceptionFilter`), contra Postgres e MinIO reais (`S3_PUBLIC_ENDPOINT=http://minio:9000` via `src/test/setup-test-env.ts`, para que as URLs pré-assinadas sejam alcançáveis de dentro do container); `beforeEach` — `cleanAllTables(dataSource)` + dois usuários autenticados (dono e outro), cada um com canal, via `createAuthenticatedUser(app)` de `test/helpers/auth.helper.ts` (extraído em SI-03.8); o vídeo do dono é criado via `POST /videos` com `{ "file_name": "clip.mp4", "mime_type": "video/mp4", "size": 134217729 }` (`part_count: 3`); `afterAll` — `StorageService.deletePrefix(videoPrefix(id))` dos vídeos criados + `app.close()`.

#### 1.1. rascunho-recem-criado-sem-partes

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-15T17:40:45Z

**Steps:**
  1. GET /videos/:id/upload com o token do dono
    - expect: HTTP `200`
    - expect: body `{ part_size: 67108864, part_count: 3, uploaded_parts: [] }`

#### 1.2. lista-partes-ja-enviadas

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-15T17:40:45Z

**Steps:**
  1. POST /videos/:id/upload/part-urls com `{ "part_numbers": [1, 3] }` e o token do dono
    - expect: HTTP `200` com duas URLs pré-assinadas
  2. `fetch` `PUT` de 5 MiB (5242880 bytes) na URL da parte 1 e de 1 MiB (1048576 bytes) na URL da parte 3
    - expect: ambas respondem `200` com header `ETag`
  3. GET /videos/:id/upload com o token do dono
    - expect: HTTP `200`
    - expect: `uploaded_parts` = `[{ part_number: 1, size: 5242880 }, { part_number: 3, size: 1048576 }]`, nessa ordem

### 2. Negar consulta fora de `draft` e a não donos

**Setup:** mesmo bootstrap do grupo 1.

#### 2.1. video-em-processing-retorna-invalid-video-status

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-15T17:40:45Z

**Steps:**
  1. Atualizar a linha do vídeo via repository para `status = 'processing'`, `processing_started_at = now()`
    - expect: update aplicado
  2. GET /videos/:id/upload com o token do dono
    - expect: HTTP `409` com `error: "INVALID_VIDEO_STATUS"`

#### 2.2. nao-dono-recebe-video-not-found

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-15T17:40:45Z

**Steps:**
  1. GET /videos/:id/upload do vídeo do dono, com o token do outro usuário
    - expect: HTTP `404` com `error: "VIDEO_NOT_FOUND"`
