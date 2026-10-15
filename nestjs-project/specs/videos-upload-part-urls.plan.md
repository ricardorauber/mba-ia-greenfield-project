---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.11
target_file: test/videos-upload-part-urls.e2e-spec.ts
---

# POST /videos/:id/upload/part-urls — Test Plan

## Application Overview

`POST /videos/:id/upload/part-urls` entrega ao cliente, em lotes de até 100 partes, as URLs pré-assinadas de `UploadPart` (assinadas com o cliente **público**, `S3_PUBLIC_ENDPOINT`) para enviar cada parte de 64 MiB direto ao storage — o plano de dados do upload de 10 GiB não passa pela API. A resposta traz `expires_in` (TTL configurável por `S3_UPLOAD_PART_URL_TTL_SECONDS`, default 3600) e `parts` na mesma ordem de `part_numbers`. Só o dono acessa (não dono → `404 VIDEO_NOT_FOUND`) e somente com o vídeo em `draft` (senão `409 INVALID_VIDEO_STATUS`); números acima de `part_count` retornam `400 INVALID_PART_NUMBER`.

## Test Scenarios

### 1. Gerar URLs pré-assinadas de partes

**Setup:** `beforeAll` — `Test.createTestingModule({ imports: [AppModule] }).compile()` + `createNestApplication()` reproduzindo a config global de `main.ts` (`ValidationPipe({ whitelist, forbidNonWhitelisted, transform })`, `DomainExceptionFilter`, `ValidationExceptionFilter`), contra Postgres e MinIO reais (`S3_PUBLIC_ENDPOINT=http://minio:9000` via `src/test/setup-test-env.ts`); `beforeEach` — `cleanAllTables(dataSource)` + dois usuários autenticados (dono e outro), cada um com canal, via `createAuthenticatedUser(app)` de `test/helpers/auth.helper.ts` (extraído em SI-03.8); o vídeo do dono é criado via `POST /videos` com `{ "file_name": "clip.mp4", "mime_type": "video/mp4", "size": 134217729 }` (`part_count: 3`); `afterAll` — `StorageService.deletePrefix(videoPrefix(id))` dos vídeos criados + `app.close()`.

#### 1.1. devolve-urls-publicas-na-ordem-pedida

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-15T17:40:45Z

**Steps:**
  1. POST /videos/:id/upload/part-urls com `{ "part_numbers": [1, 2] }` e o token do dono
    - expect: HTTP `200`
    - expect: `expires_in: 3600`
    - expect: `parts` tem 2 itens, `parts[0].part_number = 1` e `parts[1].part_number = 2`
    - expect: cada `url` começa com o valor de `S3_PUBLIC_ENDPOINT` (`http://minio:9000` no ambiente de teste) e carrega `partNumber` e `uploadId` na query
  2. POST /videos/:id/upload/part-urls com `{ "part_numbers": [3, 1] }`
    - expect: HTTP `200` com `parts[0].part_number = 3` e `parts[1].part_number = 1` (ordem do pedido preservada)

#### 1.2. put-na-url-e-aceito-pelo-storage

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-15T17:40:45Z

**Steps:**
  1. POST /videos/:id/upload/part-urls com `{ "part_numbers": [1] }` e o token do dono
    - expect: HTTP `200`
  2. `fetch` `PUT` de 5 MiB (5242880 bytes) na `url` devolvida, sem header `Authorization`
    - expect: o storage responde `200` com header `ETag` não vazio
    - expect: GET /videos/:id/upload passa a listar `{ part_number: 1, size: 5242880 }`

#### 1.3. ttl-configurado-reflete-em-expires-in

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-15T17:40:45Z

**Steps:**
  1. Em um `describe` aninhado, definir `process.env.S3_UPLOAD_PART_URL_TTL_SECONDS = '600'` antes de compilar uma segunda instância da aplicação (restaurar o valor original e fechar a instância no `afterAll` do bloco); criar o vídeo via `POST /videos` nessa instância
    - expect: aplicação sobe sem erro de validação de env
  2. POST /videos/:id/upload/part-urls com `{ "part_numbers": [1] }`
    - expect: HTTP `200` com `expires_in: 600`
    - expect: a `url` contém `X-Amz-Expires=600`

### 2. Rejeitar lotes inválidos, status incorreto e não donos

**Setup:** mesmo bootstrap do grupo 1.

#### 2.1. numero-acima-de-part-count-retorna-invalid-part-number

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-15T17:40:45Z

**Steps:**
  1. POST /videos/:id/upload/part-urls com `{ "part_numbers": [1, 4] }` (vídeo com `part_count: 3`)
    - expect: HTTP `400` com `error: "INVALID_PART_NUMBER"`

#### 2.2. lote-malformado-retorna-validation-error

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-15T17:40:45Z

**Steps:**
  1. POST /videos/:id/upload/part-urls com `{ "part_numbers": [] }`
    - expect: HTTP `400` com `error: "VALIDATION_ERROR"`
  2. POST /videos/:id/upload/part-urls com `part_numbers` de 101 itens (`1..101`)
    - expect: HTTP `400` com `error: "VALIDATION_ERROR"` (o limite de tamanho do array vence antes da checagem de `part_count`)
  3. POST /videos/:id/upload/part-urls com `{ "part_numbers": [1, 1] }`
    - expect: HTTP `400` com `error: "VALIDATION_ERROR"`
  4. POST /videos/:id/upload/part-urls com `{ "part_numbers": [0] }`
    - expect: HTTP `400` com `error: "VALIDATION_ERROR"`

#### 2.3. fora-de-draft-409-e-nao-dono-404

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-15T17:40:45Z

**Steps:**
  1. POST /videos/:id/upload/part-urls com `{ "part_numbers": [1] }` e o token do outro usuário
    - expect: HTTP `404` com `error: "VIDEO_NOT_FOUND"`
  2. Atualizar a linha do vídeo via repository para `status = 'processing'`, `processing_started_at = now()`
    - expect: update aplicado
  3. POST /videos/:id/upload/part-urls com `{ "part_numbers": [1] }` e o token do dono
    - expect: HTTP `409` com `error: "INVALID_VIDEO_STATUS"`
