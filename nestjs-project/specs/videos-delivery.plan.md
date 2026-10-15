---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.13
target_file: test/videos-delivery.e2e-spec.ts
---

# GET /videos/:id/stream, /download, /thumbnail — Test Plan

## Application Overview

Os três endpoints de entrega redirecionam (`302`) o dono para URLs pré-assinadas `GetObject` de curta duração (cliente público, TTL `S3_DELIVERY_URL_TTL_SECONDS`, default 14400), sem consumir banda da API: `stream` aponta para `videos/{id}/original` e o storage atende `Range`/`206` nativamente (reprodução sem download completo); `download` aponta para o mesmo objeto com `response-content-disposition: attachment` contendo o `original_filename`; `thumbnail` aponta para `videos/{id}/thumbnail.jpg`. Os redirects levam `Cache-Control: private, no-store`. A checagem de dono vem antes da de status: não dono sempre recebe `404 VIDEO_NOT_FOUND`; o dono com vídeo fora de `ready` (ou sem thumbnail) recebe `409 VIDEO_NOT_READY`.

## Test Scenarios

### 1. Entregar vídeo `ready` ao dono por redirect pré-assinado

**Setup:** `beforeAll` — `Test.createTestingModule({ imports: [AppModule] }).compile()` + `createNestApplication()` reproduzindo a config global de `main.ts` (`ValidationPipe({ whitelist, forbidNonWhitelisted, transform })`, `DomainExceptionFilter`, `ValidationExceptionFilter`), contra Postgres e MinIO reais (`S3_PUBLIC_ENDPOINT=http://minio:9000` via `src/test/setup-test-env.ts`); `beforeEach` — `cleanAllTables(dataSource)` + dois usuários autenticados (dono e outro), cada um com canal, via `createAuthenticatedUser(app)` de `test/helpers/auth.helper.ts` (extraído em SI-03.8); o vídeo do dono é criado via `POST /videos` com `{ "file_name": "clip.mp4", "mime_type": "video/mp4", "size": 4096 }` e levado a `ready` sem worker: gravar 4096 bytes em `videos/{id}/original` e um JPEG pequeno em `videos/{id}/thumbnail.jpg` (`ContentType: image/jpeg`) pelo cliente S3 interno, e atualizar a linha via repository para `status = 'ready'`, `size = 4096`, `has_thumbnail = true`; supertest não segue redirects, e o `Location` é exercitado com `fetch`; `afterAll` — `StorageService.deletePrefix(videoPrefix(id))` dos vídeos criados + `app.close()`.

#### 1.1. stream-redireciona-para-url-publica-com-ttl-default

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-15T17:40:45Z

**Steps:**
  1. GET /videos/:id/stream com o token do dono
    - expect: HTTP `302`
    - expect: header `Location` começa com o valor de `S3_PUBLIC_ENDPOINT` (`http://minio:9000` no ambiente de teste) e contém `X-Amz-Expires=14400`
    - expect: header `Cache-Control: private, no-store`

#### 1.2. location-do-stream-atende-range-com-206

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-15T17:40:45Z

**Steps:**
  1. GET /videos/:id/stream com o token do dono e capturar o `Location`
    - expect: HTTP `302`
  2. `fetch` `GET` no `Location` com header `Range: bytes=0-1023`, sem `Authorization`
    - expect: HTTP `206`
    - expect: header `Content-Range: bytes 0-1023/4096`
    - expect: o corpo tem exatamente 1024 bytes

#### 1.3. download-responde-com-attachment-do-nome-original

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-15T17:40:45Z

**Steps:**
  1. GET /videos/:id/download com o token do dono
    - expect: HTTP `302` com `Cache-Control: private, no-store`
  2. `fetch` `GET` no `Location`
    - expect: HTTP `200`
    - expect: header `Content-Disposition` começa com `attachment` e contém `filename="clip.mp4"`

#### 1.4. thumbnail-responde-jpeg

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-15T17:40:45Z

**Steps:**
  1. GET /videos/:id/thumbnail com o token do dono
    - expect: HTTP `302` com `Cache-Control: private, no-store`
  2. `fetch` `GET` no `Location`
    - expect: HTTP `200` com header `Content-Type: image/jpeg`

#### 1.5. ttl-de-entrega-configurado-reflete-no-location

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-10-15T17:40:45Z

**Steps:**
  1. Em um `describe` aninhado, definir `process.env.S3_DELIVERY_URL_TTL_SECONDS = '7200'` antes de compilar uma segunda instância da aplicação (restaurar o valor original e fechar a instância no `afterAll` do bloco); preparar um vídeo `ready` nessa instância como no Setup
    - expect: aplicação sobe sem erro de validação de env
  2. GET /videos/:id/stream, GET /videos/:id/download e GET /videos/:id/thumbnail com o token do dono
    - expect: os três respondem `302` e cada `Location` contém `X-Amz-Expires=7200`

### 2. Negar entrega fora de `ready` e a não donos

**Setup:** mesmo bootstrap do grupo 1, mas o vídeo do dono permanece no status indicado em cada passo (atualizado via repository), sem objetos de thumbnail.

#### 2.1. fora-de-ready-retorna-video-not-ready

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-15T17:40:45Z

**Steps:**
  1. Para cada status em `draft`, `processing` e `failed` (linha atualizada via repository), chamar GET /videos/:id/stream, GET /videos/:id/download e GET /videos/:id/thumbnail com o token do dono
    - expect: as 9 respostas são HTTP `409` com `error: "VIDEO_NOT_READY"`
    - expect: nenhuma resposta traz header `Location`

#### 2.2. nao-dono-recebe-404-mesmo-fora-de-ready

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-15T17:40:45Z

**Steps:**
  1. Com o vídeo do dono em `draft`, chamar GET /videos/:id/stream, GET /videos/:id/download e GET /videos/:id/thumbnail com o token do outro usuário
    - expect: as 3 respostas são HTTP `404` com `error: "VIDEO_NOT_FOUND"` (nunca `409`)
  2. Levar o vídeo a `ready` como no Setup do grupo 1 e repetir as 3 chamadas com o token do outro usuário
    - expect: as 3 respostas são HTTP `404` com `error: "VIDEO_NOT_FOUND"`
