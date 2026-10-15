---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.9
target_file: test/videos-get.e2e-spec.ts
---

# GET /videos/:id — Test Plan

## Application Overview

`GET /videos/:id` expõe ao dono a leitura mínima de um vídeo em qualquer status (`draft`, `processing`, `ready`, `failed`), permitindo acompanhar o processamento por polling e obter o `slug` que forma a URL única do vídeo. A posse é resolvida pelo canal (`channels.user_id = sub`); um vídeo inexistente ou de outro canal retorna o mesmo `404 VIDEO_NOT_FOUND`, sem vazar existência. Um `:id` que não é UUID é rejeitado pelo `ParseUUIDPipe` com `400 VALIDATION_ERROR`.

## Test Scenarios

### 1. Ler o vídeo como dono

**Setup:** `beforeAll` — `Test.createTestingModule({ imports: [AppModule] }).compile()` + `createNestApplication()` reproduzindo a config global de `main.ts` (`ValidationPipe({ whitelist, forbidNonWhitelisted, transform })`, `DomainExceptionFilter`, `ValidationExceptionFilter`), contra Postgres e MinIO reais; `beforeEach` — `cleanAllTables(dataSource)` + dois usuários autenticados (dono e outro), cada um com canal, via `createAuthenticatedUser(app)` de `test/helpers/auth.helper.ts` (extraído em SI-03.8); o vídeo do dono é criado via `POST /videos` (`{ "file_name": "clip.mp4", "mime_type": "video/mp4", "size": 1048576 }`); `afterAll` — `StorageService.deletePrefix(videoPrefix(id))` dos vídeos criados + `app.close()`.

#### 1.1. dono-le-rascunho-recem-criado

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-15T17:40:45Z

**Steps:**
  1. GET /videos/:id com o token do dono, para o vídeo recém-criado
    - expect: HTTP `200`
    - expect: body com o mesmo `id` e `slug` devolvidos pelo `POST /videos`, `status: "draft"`, `failure_reason: null`
    - expect: `duration`, `width`, `height`, `size` e `metadata` são `null`; `has_thumbnail: false`
    - expect: `created_at` e `updated_at` são strings ISO-8601

#### 1.2. dono-le-video-failed-com-motivo

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-15T17:40:45Z

**Steps:**
  1. Atualizar a linha do vídeo via repository para `status = 'failed'`, `failure_reason = 'unsupported_format'`
    - expect: update aplicado
  2. GET /videos/:id com o token do dono
    - expect: HTTP `200` com `status: "failed"` e `failure_reason: "unsupported_format"`

### 2. Negar leitura a não donos, ids inválidos e anônimos

**Setup:** mesmo bootstrap do grupo 1.

#### 2.1. nao-dono-recebe-404-identico-ao-inexistente

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-15T17:40:45Z

**Steps:**
  1. GET /videos/:id do vídeo do dono, com o token do outro usuário
    - expect: HTTP `404` com `error: "VIDEO_NOT_FOUND"`
  2. GET /videos/:id com um UUID v4 aleatório inexistente, com o token do outro usuário
    - expect: HTTP `404` com `error: "VIDEO_NOT_FOUND"`
    - expect: os dois corpos de erro são idênticos (`statusCode`, `error`, `message`)

#### 2.2. id-nao-uuid-retorna-validation-error

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-15T17:40:45Z

**Steps:**
  1. GET /videos/abc com o token do dono
    - expect: HTTP `400` com `error: "VALIDATION_ERROR"`

#### 2.3. sem-token-retorna-401

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-15T17:40:45Z

**Steps:**
  1. GET /videos/:id do vídeo do dono, sem header `Authorization`
    - expect: HTTP `401`
