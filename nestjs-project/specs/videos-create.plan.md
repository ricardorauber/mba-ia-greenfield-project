---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.8
target_file: test/videos-create.e2e-spec.ts
---

# POST /videos — Test Plan

## Application Overview

`POST /videos` inicia o upload de um vídeo de até 10 GiB: valida o formato (allowlist `video/mp4` / `video/webm`, extensão de `file_name` compatível com `mime_type`) e o tamanho declarado, abre o multipart upload direto no storage em `videos/{videoId}/original` e pré-cadastra automaticamente o vídeo como `draft` no canal do usuário autenticado, devolvendo o `VideoResponseDto` acrescido do plano de partes (`upload.part_size` fixo de 64 MiB e `upload.part_count = ceil(size / part_size)`). Os bytes do vídeo nunca passam pela API. O endpoint exige JWT (guard global) e é `@SkipThrottle()` — o rate limit de auth não se aplica.

## Test Scenarios

### 1. Iniciar upload e pré-cadastrar o rascunho

**Setup:** `beforeAll` — `Test.createTestingModule({ imports: [AppModule] }).compile()` + `createNestApplication()` reproduzindo a config global de `main.ts` (`ValidationPipe({ whitelist, forbidNonWhitelisted, transform })`, `DomainExceptionFilter`, `ValidationExceptionFilter`), contra Postgres, MinIO e Redis reais (`QUEUE_PREFIX=streamtube-test`, `S3_PUBLIC_ENDPOINT=http://minio:9000` via `src/test/setup-test-env.ts`); `beforeEach` — `cleanAllTables(dataSource)` + usuário autenticado (com canal) via `createAuthenticatedUser(app)` de `test/helpers/auth.helper.ts` (extraído neste SI — ação técnica 6; a suíte de auth continua passando sem mudança de comportamento); `afterAll` — `StorageService.deletePrefix(videoPrefix(id))` para cada vídeo criado + `app.close()`.

#### 1.1. cria-rascunho-com-plano-de-uma-parte

**Covers AC:** #1, #7
**Source:** auto
**Last sync:** 2026-10-15T17:40:45Z

**Steps:**
  1. POST /videos com `Authorization: Bearer <access_token>` e body `{ "file_name": "clip.mp4", "mime_type": "video/mp4", "size": 1048576 }`
    - expect: HTTP `201`
    - expect: body com `id` (UUID), `status: "draft"`, `slug` de 11 caracteres em `[A-Za-z0-9_-]`, `title: "clip"`, `original_filename: "clip.mp4"`, `mime_type: "video/mp4"`
    - expect: `failure_reason`, `duration`, `width`, `height`, `size` e `metadata` são `null`; `has_thumbnail: false`
    - expect: `upload.part_size: 67108864` e `upload.part_count: 1`
  2. Consultar a linha em `videos` pelo `id` devolvido
    - expect: a linha existe com `status = 'draft'`, `upload_id` preenchido e `channel_id` igual ao id do canal do usuário autenticado

#### 1.2. tamanho-maximo-gera-160-partes

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-15T17:40:45Z

**Steps:**
  1. POST /videos com body `{ "file_name": "big.mp4", "mime_type": "video/mp4", "size": 10737418240 }`
    - expect: HTTP `201`
    - expect: `upload.part_count: 160` e `upload.part_size: 67108864`

#### 1.3. requisicoes-seguidas-nao-sao-limitadas

**Covers AC:** #8
**Source:** auto
**Last sync:** 2026-10-15T17:40:45Z

**Steps:**
  1. Disparar 15 POST /videos válidos em sequência, com o mesmo token, dentro do mesmo minuto
    - expect: todas as 15 respostas são `201`; nenhuma é `429`
    - expect: os 15 `slug` devolvidos são distintos

### 2. Rejeitar entradas inválidas e acesso anônimo

**Setup:** mesmo bootstrap do grupo 1.

#### 2.1. tamanho-acima-do-limite-retorna-video-too-large

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-15T17:40:45Z

**Steps:**
  1. POST /videos com body `{ "file_name": "big.mp4", "mime_type": "video/mp4", "size": 10737418241 }`
    - expect: HTTP `400` com envelope `{ statusCode: 400, error: "VIDEO_TOO_LARGE", message }`
    - expect: `SELECT count(*) FROM videos` = 0

#### 2.2. formato-nao-suportado-retorna-unsupported-video-format

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-15T17:40:45Z

**Steps:**
  1. POST /videos com body `{ "file_name": "clip.mov", "mime_type": "video/quicktime", "size": 1048576 }`
    - expect: HTTP `400` com `error: "UNSUPPORTED_VIDEO_FORMAT"`
  2. POST /videos com body `{ "file_name": "clip.webm", "mime_type": "video/mp4", "size": 1048576 }`
    - expect: HTTP `400` com `error: "UNSUPPORTED_VIDEO_FORMAT"`
    - expect: nenhuma linha criada em `videos`

#### 2.3. corpo-invalido-retorna-validation-error

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-15T17:40:45Z

**Steps:**
  1. POST /videos com body `{ "file_name": "clip.mp4", "mime_type": "video/mp4" }` (sem `size`)
    - expect: HTTP `400` com `error: "VALIDATION_ERROR"`
  2. POST /videos com body `{ "file_name": "clip.mp4", "mime_type": "video/mp4", "size": 1048576, "foo": "bar" }`
    - expect: HTTP `400` com `error: "VALIDATION_ERROR"` (propriedade desconhecida rejeitada por `forbidNonWhitelisted`)

#### 2.4. sem-token-retorna-401

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-15T17:40:45Z

**Steps:**
  1. POST /videos sem header `Authorization`, com body válido
    - expect: HTTP `401`
    - expect: nenhuma linha criada em `videos`
