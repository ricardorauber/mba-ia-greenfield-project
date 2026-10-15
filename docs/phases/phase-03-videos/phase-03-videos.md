---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-15T14:18:42-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-15T14:18:42-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-15T14:18:05-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-15T13:28:45-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar o backend de upload e processamento de vídeos do StreamTube: serviço de armazenamento de arquivos (vídeos e thumbnails) em object storage S3-compatível (MinIO local), serviço de processamento em segundo plano (filas BullMQ + `video-worker`), upload resumível de até 10GB direto para o storage sem impacto na performance da API, pré-cadastro automático do vídeo como rascunho ao iniciar o upload, processamento automático após o upload (extração de duração e metadados com ffprobe) com geração automática de thumbnail a partir de um frame, URL única por vídeo (slug sem conflito) e reprodução via streaming e download do vídeo pelo usuário (dono) via URLs pré-assinadas.

---

## Step Implementations

### SI-03.1 — Infra: dependências, FFmpeg na imagem e serviços Compose (minio, minio-init, redis)

**Description:** Instalar as bibliotecas decididas com pins exatos, colocar FFmpeg na imagem de dev compartilhada e subir object storage (MinIO + bootstrap do bucket) e Redis junto com o backend — a infraestrutura que todos os SIs seguintes exercitam de verdade nos testes.

**Technical actions:**

1. Instalar dentro do container, com `npm install --save-exact`: `@nestjs/bullmq@12.0.0`, `bullmq@6.3.15`, `ioredis@6.0.0` (peer opcional obrigatório no BullMQ 6) (per `phase-03-videos/TD-01`), `@aws-sdk/client-s3@3.1152.0` e `@aws-sdk/s3-request-presigner@3.1152.0` (sempre na mesma versão) (per `phase-03-videos/TD-03`).
2. Atualizar `nestjs-project/Dockerfile.dev` — adicionar `ffmpeg` ao `apt install` (pacote Debian 12, 5.1.x; fornece `ffmpeg` e `ffprobe`) e reconstruir a imagem com `docker compose build` (per `phase-03-videos/TD-02` Note, `phase-03-videos/TD-11` Note).
3. Adicionar a `nestjs-project/compose.yaml`: serviço `minio` (`image: pgsty/minio:RELEASE.2026-08-04T00-00-00Z`, `command: server /data --console-address ":9001"`, portas `9000:9000` e `9001:9001`, `MINIO_ROOT_USER: ${S3_ACCESS_KEY_ID}`, `MINIO_ROOT_PASSWORD: ${S3_SECRET_ACCESS_KEY}`, `MINIO_API_CORS_ALLOW_ORIGIN: "*"` (somente dev), volume nomeado `minio-data:/data`, healthcheck em `http://localhost:9000/minio/health/live` — confirmar no momento da implementação qual binário de probe a imagem fixada traz, `curl` ou `mc ready local`) (per `phase-03-videos/TD-04`); serviço one-shot `minio-init` (`image: pgsty/mc:RELEASE.2026-09-16T00-00-00Z`, `depends_on: minio: condition: service_healthy`, `restart: "no"`, entrypoint `sh -c` executando `mc alias set local http://minio:9000 "$$S3_ACCESS_KEY_ID" "$$S3_SECRET_ACCESS_KEY"` e `mc mb --ignore-existing local/"$$S3_BUCKET"`; o bucket fica privado) (per `phase-03-videos/TD-04`, `phase-03-videos/TD-06`).
4. Adicionar o serviço `redis` (`image: redis:8.10.2-alpine`, `command: redis-server --maxmemory-policy noeviction`, porta `6379:6379`, healthcheck `redis-cli ping`) e declarar o volume `minio-data`; estender `nestjs-api.depends_on` com `redis: condition: service_healthy` e `minio-init: condition: service_completed_successfully` (per `phase-03-videos/TD-01` Note).
5. Adicionar a `.env.example` e ao `.env` local, usando nomes de serviço Compose como host: `S3_ENDPOINT=http://minio:9000`, `S3_PUBLIC_ENDPOINT=http://localhost:9000`, `S3_REGION=us-east-1`, `S3_ACCESS_KEY_ID=streamtube`, `S3_SECRET_ACCESS_KEY=streamtube-secret` (MinIO exige ≥ 8 caracteres), `S3_BUCKET=streamtube-videos`, `S3_FORCE_PATH_STYLE=true`, `S3_UPLOAD_PART_URL_TTL_SECONDS=3600`, `S3_DELIVERY_URL_TTL_SECONDS=14400`, `REDIS_HOST=redis`, `REDIS_PORT=6379`, `QUEUE_PREFIX=streamtube` (per `phase-03-videos/TD-05`).

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` sobe `db`, `mailpit`, `minio`, `redis` e `nestjs-api`; `docker compose ps` mostra `minio` e `redis` como `healthy` e `minio-init` saído com código 0.
- Rodar de novo `docker compose up minio-init` com o bucket já existente sai com código 0 (bootstrap idempotente).
- `docker compose exec redis redis-cli CONFIG GET maxmemory-policy` retorna `noeviction`.
- `docker compose exec nestjs-api ffprobe -version` e `docker compose exec nestjs-api ffmpeg -version` imprimem uma versão 5.1.x.
- `nestjs-project/package.json` lista as cinco bibliotecas novas com versão exata (sem `^`), e a suíte existente (`npm test -- --runInBand` e `npm run test:e2e`) continua passando.

---

### SI-03.2 — Namespaces de configuração `storage` e `queue` e ambiente de teste isolado

**Description:** Criar os namespaces de configuração do storage S3 e da fila (com os TTLs das URLs pré-assinadas configuráveis por env) seguindo o padrão `registerAs` + Joi herdado de Phase 01, e isolar a suíte de testes da fila e do endpoint público usados em dev.

**Technical actions:**

1. Criar `src/config/storage.config.ts` — `registerAs('storage', () => ({ endpoint, publicEndpoint, region, accessKeyId, secretAccessKey, bucket, forcePathStyle, uploadPartUrlTtlSeconds, deliveryUrlTtlSeconds }))` lendo `S3_ENDPOINT` (opcional; ausente em AWS), `S3_PUBLIC_ENDPOINT` (opcional; fallback = `S3_ENDPOINT`), `S3_REGION` (default `us-east-1`), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET` (default `streamtube-videos`), `S3_FORCE_PATH_STYLE` (`'true'`/`'false'` → boolean, default `true`), `S3_UPLOAD_PART_URL_TTL_SECONDS` (default `3600`) e `S3_DELIVERY_URL_TTL_SECONDS` (default `14400`) (per `phase-01-configuracao-base/TD-03`, `phase-03-videos/TD-05`).
2. Criar `src/config/queue.config.ts` — `registerAs('queue', () => ({ redisHost, redisPort, prefix }))` lendo `REDIS_HOST` (default `redis`), `REDIS_PORT` (default `6379`) e `QUEUE_PREFIX` (default `streamtube`) (per `phase-03-videos/TD-01`).
3. Estender `src/config/env.validation.ts` — `S3_ENDPOINT`/`S3_PUBLIC_ENDPOINT` `Joi.string().uri()` opcionais; `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` `required()`; `S3_REGION`, `S3_BUCKET`, `QUEUE_PREFIX` strings com default; `S3_FORCE_PATH_STYLE` `valid('true','false')`; os dois TTLs `Joi.number().integer().min(60).max(604800)` (máximo de 7 dias do SigV4) com defaults 3600 e 14400; `REDIS_HOST` string default `redis`; `REDIS_PORT` `port()` default 6379 (per `phase-01-configuracao-base/TD-02`).
4. Registrar `storageConfig` e `queueConfig` no `load` do `ConfigModule.forRoot` em `src/app.module.ts`.
5. Criar `src/test/setup-test-env.ts` — define `process.env.QUEUE_PREFIX = 'streamtube-test'` e `process.env.S3_PUBLIC_ENDPOINT = 'http://minio:9000'` (os testes rodam dentro de `nestjs-api` e precisam usar as URLs pré-assinadas de verdade — per `phase-03-videos/TD-05` Note) e incluí-lo em `setupFiles` **antes** de `dotenv/config` no jest do `package.json` (`<rootDir>/test/setup-test-env.ts`) e em `test/jest-e2e.json` (`<rootDir>/src/test/setup-test-env.ts`), para que o `.env` de dev não sobrescreva esses valores.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` | Integration (padrão existente): S3 credentials obrigatórias, defaults dos TTLs/Redis/bucket, rejeição de TTL < 60 e de `S3_FORCE_PATH_STYLE` inválido; `requiredEnv` do arquivo passa a incluir `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` | `src/config/env.validation.integration-spec.ts` |
| `storageConfig` | Unit: conversão de `S3_FORCE_PATH_STYLE` para boolean, TTLs numéricos, fallback de `publicEndpoint` para `endpoint` | `src/config/storage.config.spec.ts` |

**Dependencies:** SI-03.1 — variáveis de ambiente e serviços precisam existir.

**Acceptance criteria:**

- Subir a aplicação sem `S3_ACCESS_KEY_ID` falha no bootstrap com erro de validação Joi citando a variável.
- Com `S3_UPLOAD_PART_URL_TTL_SECONDS` e `S3_DELIVERY_URL_TTL_SECONDS` ausentes, o namespace `storage` resolve `uploadPartUrlTtlSeconds = 3600` e `deliveryUrlTtlSeconds = 14400`.
- `S3_UPLOAD_PART_URL_TTL_SECONDS=30` impede o bootstrap com erro de validação.
- Sem `S3_PUBLIC_ENDPOINT`, o namespace `storage` usa o valor de `S3_ENDPOINT` como endpoint público.
- Dentro do processo Jest, `QUEUE_PREFIX` vale `streamtube-test` e `S3_PUBLIC_ENDPOINT` vale `http://minio:9000`, mesmo com o `.env` de dev definindo outros valores.

---

### SI-03.3 — DatabaseModule e opções de ConfigModule compartilhadas entre API e worker

**Description:** Extrair a configuração do `ConfigModule` e a conexão TypeORM do `AppModule` para artefatos reutilizáveis, porque o `video-worker` (mesma base de código, entrypoint separado — per `phase-03-videos/TD-02`) precisa da mesma configuração validada e da mesma conexão sem duplicar parâmetros.

**Technical actions:**

1. Criar `src/config/config-module.options.ts` — exporta `configModuleOptions: ConfigModuleOptions` com `isGlobal: true`, `load: [appConfig, authConfig, databaseConfig, mailConfig, swaggerConfig, storageConfig, queueConfig]`, `validationSchema: envValidationSchema` e `validationOptions: { allowUnknown: true, abortEarly: false }` (per `phase-01-configuracao-base/TD-01`).
2. Criar `src/database/database.module.ts` — `DatabaseModule` encapsulando o `TypeOrmModule.forRootAsync` hoje inline no `AppModule` (`imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `autoLoadEntities: true`, `synchronize: false`), mantendo `databaseConfig` como fonte única dos parâmetros de conexão (convenção herdada de Phase 01).
3. Atualizar `src/app.module.ts` para `ConfigModule.forRoot(configModuleOptions)` + `DatabaseModule`, sem mudança de comportamento.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `DatabaseModule` | Integration: compila `ConfigModule.forRoot(configModuleOptions)` + `DatabaseModule`, `DataSource.isInitialized === true` e `SELECT 1` responde | `src/database/database.module.integration-spec.ts` |

**Dependencies:** SI-03.2 — os namespaces `storage` e `queue` entram na lista compartilhada.

**Acceptance criteria:**

- `GET /` continua retornando `200` e as suítes existentes de auth (unit, integration e e2e) passam sem alteração.
- Os parâmetros de conexão do banco aparecem em um único lugar (`databaseConfig`, consumido por `DatabaseModule` e por `data-source.ts`); o `AppModule` não declara mais `TypeOrmModule.forRootAsync`.
- Uma aplicação Nest montada só com `ConfigModule.forRoot(configModuleOptions)` + `DatabaseModule` conecta ao serviço `db` e executa consultas.

---

### SI-03.4 — StorageModule: clientes S3 interno/público, multipart e URLs pré-assinadas

**Description:** Entregar o serviço de armazenamento de arquivos (vídeos e thumbnails) como um módulo de infraestrutura agnóstico de domínio, sobre o AWS SDK v3 contra MinIO local / S3 em produção, com os dois endpoints exigidos para assinar URLs acessíveis pelo browser.

**Technical actions:**

1. Criar `src/storage/storage.constants.ts` (tokens `S3_INTERNAL_CLIENT`, `S3_PUBLIC_CLIENT`) e `src/storage/storage.module.ts` — dois providers `S3Client` construídos a partir de `storageConfig`: o interno com `endpoint = S3_ENDPOINT` e o público com `endpoint = S3_PUBLIC_ENDPOINT`, ambos com `region`, `forcePathStyle`, `credentials`, `requestChecksumCalculation: 'WHEN_REQUIRED'` e `responseChecksumValidation: 'WHEN_REQUIRED'` (evita checksums ligados a um corpo que o browser ainda não enviou); exporta `StorageService` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-05`).
2. Criar `src/storage/storage.service.ts` — operações de multipart (cliente interno): `createMultipartUpload(key, contentType)` → `uploadId`; `listParts(key, uploadId)` paginado por `PartNumberMarker`/`IsTruncated` → `{ partNumber, size, etag }[]` em ordem crescente, ou `null` quando `NoSuchUpload`; `completeMultipartUpload(key, uploadId, parts)`; `abortMultipartUpload(key, uploadId)` tratando `NoSuchUpload` como sucesso (idempotente) (per `phase-03-videos/TD-07`, `phase-03-videos/TD-13`).
3. Operações de objeto (cliente interno): `headObject(key)` → `{ contentLength } | null` (`NotFound`/`NoSuchKey` → `null`); `putObject(key, body, contentType)`; `deleteObject(key)`; `deletePrefix(prefix)` (`ListObjectsV2` + `DeleteObjects`). Erros do SDK são identificados via `S3ServiceException` + `err.name` em `src/storage/s3-errors.ts` (`isS3Error(err, ...names)`).
4. Pré-assinatura: `presignUploadPart(key, uploadId, partNumber)` com o cliente **público** e `expiresIn = uploadPartUrlTtlSeconds`; `presignGet(key, { responseContentDisposition? })` com o cliente **público** e `expiresIn = deliveryUrlTtlSeconds`; `presignInternalGet(key, expiresIn = 3600)` com o cliente **interno** (entrada do worker — per `phase-03-videos/TD-12`). Os métodos públicos devolvem também o `expiresIn` usado.
5. O bucket vem sempre de `storageConfig.bucket` (nunca hardcoded); `StorageModule` não conhece chaves de domínio — as chaves `videos/{videoId}/…` são montadas pelo domínio de vídeos (SI-03.6).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration (MinIO real): multipart criado → `PUT` via `fetch` em duas URLs de parte (5 MiB + resto) → `listParts` com tamanhos/ETags → `complete` → `headObject` com o tamanho → `presignGet` + `Range: bytes=0-99` → `206` com 100 bytes → `responseContentDisposition` refletido no header → `abortMultipartUpload` repetido sem erro → `deletePrefix` limpa | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compilação do módulo; os dois clientes resolvem endpoints distintos (`S3_ENDPOINT` vs `S3_PUBLIC_ENDPOINT`) | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1 (MinIO + bucket), SI-03.2 (namespace `storage`).

**Acceptance criteria:**

- Uma URL pré-assinada de `UploadPart` aceita `PUT` de dentro da rede Compose e o storage responde `200` com header `ETag`.
- URLs pré-assinadas para o browser começam com `S3_PUBLIC_ENDPOINT`; a URL de entrada do worker começa com `S3_ENDPOINT`.
- O parâmetro `X-Amz-Expires` das URLs de parte vale `S3_UPLOAD_PART_URL_TTL_SECONDS` (default 3600) e o das URLs de leitura vale `S3_DELIVERY_URL_TTL_SECONDS` (default 14400).
- As URLs de `UploadPart` não contêm `x-amz-checksum-crc32` nem `x-amz-sdk-checksum-algorithm`.
- Um `GET` na URL pré-assinada do objeto com `Range: bytes=0-99` retorna `206` com exatamente 100 bytes.
- Abortar um multipart upload já abortado termina sem erro; `headObject` de uma chave inexistente retorna `null`.

---

### SI-03.5 — QueueModule e fila `video-processing` (contratos + producer)

**Description:** Entregar o serviço de processamento em segundo plano no lado produtor: conexão BullMQ/Redis compartilhada, contratos das filas e um producer idempotente usado pela API e pelo sweep — sem nenhum consumer no grafo da API.

**Technical actions:**

1. Criar `src/queue/queue.module.ts` — `QueueModule` com `BullModule.forRootAsync({ imports: [ConfigModule], inject: [queueConfig.KEY], useFactory: (cfg) => ({ connection: { host: cfg.redisHost, port: cfg.redisPort }, prefix: cfg.prefix }) })` (per `phase-03-videos/TD-01`).
2. Criar `src/video-processing/video-processing.queue.ts` — `VIDEO_PROCESSING_QUEUE = 'video-processing'`, `PROCESS_VIDEO_JOB = 'process-video'`, `VIDEO_RECONCILIATION_QUEUE = 'video-reconciliation'`, `RECONCILE_JOB = 'reconcile'`, `RECONCILE_SCHEDULER_ID = 'reconcile-videos'`, interface `ProcessVideoJobData { videoId: string }` e `PROCESS_VIDEO_JOB_OPTIONS` (`attempts: 5`, `backoff: { type: 'exponential', delay: 5000 }`, `removeOnComplete: true`, `removeOnFail: true`) — conforme `### Events/Messages` (per `phase-03-videos/TD-13`).
3. Criar `src/video-processing/video-processing.producer.ts` — `VideoProcessingProducer.enqueue(videoId)` com `@InjectQueue(VIDEO_PROCESSING_QUEUE)` chamando `queue.add(PROCESS_VIDEO_JOB, { videoId }, { ...PROCESS_VIDEO_JOB_OPTIONS, jobId: videoId })` (per `phase-03-videos/TD-08`).
4. Criar `src/video-processing/video-processing-queue.module.ts` — `VideoProcessingQueueModule` importando `QueueModule` e `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`, provendo e exportando apenas o producer (nenhum `@Processor` aqui — per `phase-03-videos/TD-02`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingProducer` | Integration (Redis real, prefixo único por arquivo, `queue.obliterate({ force: true })` no `afterAll`): job criado em `waiting` com `id = videoId`, `data = { videoId }`, `opts.attempts = 5` e backoff exponencial; segundo `enqueue` com o mesmo id não duplica; após `job.remove()` um novo `enqueue` cria outro job | `src/video-processing/video-processing.producer.integration-spec.ts` |

**Dependencies:** SI-03.1 (Redis), SI-03.2 (namespace `queue`).

**Acceptance criteria:**

- Enfileirar um `videoId` cria exatamente um job `process-video` na fila `video-processing` com `jobId` igual ao `videoId` e payload `{ "videoId": "<uuid>" }`.
- Enfileirar o mesmo `videoId` enquanto o job existe não cria um segundo job.
- Depois que o job é removido do Redis, enfileirar o mesmo `videoId` cria um novo job.
- As chaves da fila ficam sob o prefixo configurado (`streamtube:video-processing:*` em dev, `streamtube-test:…` nos testes), visíveis com `redis-cli --scan`.

---

### SI-03.6 — Entidade `Video` e migration `CreateVideos`

**Description:** Persistir o vídeo conforme `### Data Model → Video` — status em enum próprio, slug único, metadados de processamento e vínculo com o canal — e manter a suíte de migrations e o helper de limpeza de testes coerentes com a nova tabela.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` — entity `Video` (`@Entity('videos')`) com todos os campos de `### Data Model → Video`; `export enum VideoStatus { Draft = 'draft', Processing = 'processing', Ready = 'ready', Failed = 'failed' }`; `export type VideoFailureReason = 'upload_abandoned' | 'size_mismatch' | 'unsupported_format' | 'invalid_media' | 'processing_error'`; interface `VideoMetadata`; `@ManyToOne(() => Channel, { onDelete: 'CASCADE' })` + `@JoinColumn({ name: 'channel_id' })`; `@Index` em `channel_id` e em (`status`, `created_at`). Transformers bigint/numeric → `number` em `src/database/transformers/numeric.transformer.ts` (per `phase-03-videos/TD-10`, `phase-03-videos/TD-11`, `phase-03-videos/TD-14`).
2. Criar `src/videos/video-storage-keys.ts` — `videoOriginalKey(id)` → `videos/{id}/original`, `videoThumbnailKey(id)` → `videos/{id}/thumbnail.jpg`, `videoPrefix(id)` → `videos/{id}/` (per `phase-03-videos/TD-06`).
3. Gerar `src/database/migrations/{timestamp}-CreateVideos.ts` com `npm run migration:generate -- src/database/migrations/CreateVideos` (dentro do container) e revisar: `CREATE TYPE "public"."videos_status_enum"`, tabela, `UNIQUE` em `slug`, índices, FK `ON DELETE CASCADE`; o `down` remove FK, índices, tabela e o tipo enum.
4. Estender `src/database/migrations.integration-spec.ts` — incluir `Video` e `CreateVideos{timestamp}` no DataSource, `'videos'` em `MANAGED_TABLES`, `'videos_status_enum'` em `MANAGED_ENUM_TYPES`, esperar 3 migrations aplicadas e a tabela `videos` na lista; o teste de revert passa a validar que desfazer a última migration remove `videos` e o tipo `videos_status_enum` (as tabelas de token permanecem).
5. Atualizar `cleanAllTables` em `src/test/create-test-data-source.ts` para executar `DELETE FROM "videos"` antes de `channels` (FK).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: defaults (`status = draft`, `has_thumbnail = false`, campos de processamento `null`), violação de unique em `slug`, cascade ao remover o canal, `declared_size`/`size` 10737418240 lidos como `number`, `duration` numeric lido como `number`, round-trip do jsonb `metadata`, valor de status fora do enum rejeitado | `src/videos/entities/video.entity.integration-spec.ts` |
| Migrations | Integration: aplica 3 migrations, cria `videos` + `videos_status_enum`; revert da última remove ambos | `src/database/migrations.integration-spec.ts` |

**Dependencies:** none — depende apenas das tabelas `channels`/`users` de Phase 02.

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` e o tipo `videos_status_enum`; `npm run migration:revert` em seguida remove os dois.
- Inserir dois vídeos com o mesmo `slug` falha com violação de unicidade.
- Remover um canal remove os vídeos dele.
- Um vídeo inserido só com os campos obrigatórios fica com `status = draft`, `has_thumbnail = false` e `duration`/`width`/`height`/`size`/`metadata`/`failure_reason`/`processing_started_at` nulos.
- `declared_size = 10737418240` é lido de volta como o número `10737418240`.
- A suíte de auth e2e continua passando com vídeos presentes no banco (a limpeza respeita a FK).

---

### SI-03.7 — VideosService: pré-cadastro com slug único, leitura do dono e transições condicionais

**Description:** Concentrar no domínio de vídeos a persistência do rascunho (com a URL única por vídeo garantida pelo banco), a resolução de dono via canal e as transições de status condicionais que API e worker compartilham.

**Technical actions:**

1. Extrair `isPgUniqueViolationOnColumn` de `src/channels/channels.service.ts` para `src/database/pg-errors.ts` (sem mudança de comportamento, reutilizado pelos dois serviços) e adicionar `ChannelsService.findByUserId(userId): Promise<Channel | null>` — a busca do canal pertence ao domínio de canais (per `phase-03-videos/TD-10`).
2. Criar `src/videos/video-slug.util.ts` — `generateVideoSlug()` = `randomBytes(8).toString('base64url')` (11 caracteres) (per `phase-03-videos/TD-14`) — e `src/videos/exceptions/video.exceptions.ts` com as classes de `### Error Catalog` (`UnsupportedVideoFormatException`, `VideoTooLargeException`, `InvalidPartNumberException`, `ChannelNotFoundException`, `VideoNotFoundException`, `InvalidVideoStatusException`, `UploadIncompleteException`, `UploadSizeMismatchException`, `VideoNotReadyException`), estendendo `DomainException`.
3. Criar `src/videos/videos.service.ts` — `createDraft({ id, channelId, title, originalFilename, mimeType, declaredSize, uploadId })` insere com slug gerado e, em violação de unique na coluna `slug`, tenta de novo com novo slug até 5 vezes (outras violações são relançadas) (per `phase-03-videos/TD-14`).
4. Leituras e transições: `findOwnedOrFail(userId, videoId)` (join `channels.user_id = :userId`; ausente ou de outro canal → `VideoNotFoundException`), `findById(id)`, `markProcessing(id)` (`draft → processing`, grava `processing_started_at`), `markReady(id, result)` (`processing → ready`), `markFailed(id, reason, expectedStatus)` — todas `UPDATE ... WHERE id = :id AND status = :expected` retornando `boolean`; finders do sweep `findAbandonedDrafts(createdBefore, limit)` e `findStuckProcessing(startedBefore, limit)` (per `phase-03-videos/TD-10`, `phase-03-videos/TD-13`).
5. Criar `src/videos/videos.module.ts` — `TypeOrmModule.forFeature([Video])`, importa `ChannelsModule`, provê e exporta `VideosService`; registrar `VideosModule` no `AppModule`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `generateVideoSlug` | Unit: 11 caracteres, alfabeto base64url (`[A-Za-z0-9_-]`), 1000 chamadas sem repetição | `src/videos/video-slug.util.spec.ts` |
| `VideosService` | Unit: retry de slug (1ª inserção com unique violation em `slug` → 2ª com outro slug), violação em outra coluna relançada, desistência após 5 tentativas | `src/videos/videos.service.spec.ts` |
| `VideosService` | Integration: `createDraft` persiste; `findOwnedOrFail` de vídeo de outro usuário lança `VideoNotFoundException`; `markProcessing` só funciona a partir de `draft` (2ª chamada → `false`); `markFailed(..., 'draft')` não sobrescreve um vídeo já em `processing`; finders respeitam os limiares de tempo | `src/videos/videos.service.integration-spec.ts` |
| `ChannelsService.findByUserId` | Integration: retorna o canal do usuário e `null` para usuário sem canal | `src/channels/channels.service.integration-spec.ts` |
| `VideosModule` | Unit: compilação do módulo | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.3 (`DatabaseModule`), SI-03.6 (entidade e migration).

**Acceptance criteria:**

- `createDraft` persiste um vídeo `draft` com `slug` de 11 caracteres base64url, distinto do de todos os outros vídeos.
- Quando o slug sorteado já existe, o vídeo é criado com outro slug, sem erro para o chamador.
- Buscar como dono um vídeo de outro canal resulta em `VIDEO_NOT_FOUND`, o mesmo resultado de um id inexistente.
- `markProcessing` em um vídeo que não está em `draft` não altera a linha e informa transição perdida.
- `markFailed` com status esperado `draft` não altera um vídeo que já foi para `processing`.
- `ChannelsService` continua criando canais com nicknames únicos (comportamento de Phase 02 inalterado).

---

### SI-03.8 — Endpoint POST /videos (início do upload + pré-cadastro do rascunho)

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-create.plan.md`
**Authorization:** Authenticated (o vídeo é criado no canal do usuário — ver `### Authorization Matrix`)

**Description:** Ao iniciar o upload, validar formato e tamanho declarados, abrir o multipart upload direto no storage e pré-cadastrar automaticamente o vídeo como rascunho, devolvendo o plano de partes — o primeiro passo do upload de até 10GB que nunca passa pela API.

**Technical actions:**

1. Criar `src/videos/videos.constants.ts` (`MAX_VIDEO_SIZE_BYTES = 10737418240`, `UPLOAD_PART_SIZE_BYTES = 67108864`, `ALLOWED_VIDEO_TYPES = { 'video/mp4': '.mp4', 'video/webm': '.webm' }`) e `src/videos/video-uploads.service.ts` com `initiate(userId, dto)`: valida allowlist + extensão (case-insensitive) compatível com `mime_type` → `UnsupportedVideoFormatException`; `size > MAX_VIDEO_SIZE_BYTES` → `VideoTooLargeException`; `ChannelsService.findByUserId` → `ChannelNotFoundException`; gera `id = randomUUID()`, chama `StorageService.createMultipartUpload(videoOriginalKey(id), mime_type)` e `VideosService.createDraft(...)` com `title` = `dto.title` ou `file_name` sem extensão truncado em 100; se `createDraft` falhar, aborta o multipart (best-effort) e relança (per `phase-03-videos/TD-07`, `phase-03-videos/TD-09`, `phase-03-videos/TD-10`).
2. Criar DTOs conforme `### API Contracts → POST /videos` e `#### Validation Rules — Videos`: `src/videos/dto/create-video.dto.ts` (`file_name`, `mime_type`, `size`, `title`), `src/videos/dto/video-response.dto.ts` (`VideoResponseDto` + `VideoMetadataDto`, `static fromEntity(video)`; `@ApiProperty` explícito com `nullable: true` e `enum` de `status`) e `src/videos/dto/create-video-response.dto.ts` (`VideoResponseDto` + `upload: { part_size, part_count }`).
3. Criar `src/videos/videos.controller.ts` — `@ApiTags('videos')`, `@ApiBearerAuth('access-token')`, `@SkipThrottle()` (o throttling de `phase-02-auth/TD-08` é escopado ao auth), `@Controller('videos')`; `@Post()` `create(@CurrentUser() user: JwtPayload, @Body() dto: CreateVideoDto)` → `201`.
4. Decorators OpenAPI do `create`: `@ApiOperation`, `@ApiResponse` 201 (`type: CreateVideoResponseDto`), 400 (`VALIDATION_ERROR`, `UNSUPPORTED_VIDEO_FORMAT`, `VIDEO_TOO_LARGE`), 401 e 404 (`CHANNEL_NOT_FOUND`) com `$ref: getSchemaPath(ApiErrorEnvelope)` (per `openapi-docs-nestjs/TD-01`).
5. Registrar em `VideosModule`: importar `StorageModule`, prover `VideoUploadsService` e declarar `VideosController`.
6. Extrair o fluxo registrar → confirmar → login de `test/auth.e2e-spec.ts` para `test/helpers/auth.helper.ts` (`createAuthenticatedUser(app)` devolvendo `access_token`), sem mudar o comportamento da suíte de auth — os specs E2E de SI-03.8 a SI-03.13 dependem dele.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoUploadsService.initiate` | Unit: MIME fora da allowlist, extensão incompatível, extensão em maiúsculas aceita, `size` = limite aceito e limite + 1 rejeitado, título default (sem extensão, truncado em 100), `part_count` para 1 byte / 64 MiB exatos / 10 GiB (= 160), abort chamado quando `createDraft` falha | `src/videos/video-uploads.service.spec.ts` |
| `VideoUploadsService.initiate` | Integration (Postgres + MinIO reais): cria a linha `draft` com `upload_id`, e `listParts` desse upload no MinIO retorna lista vazia (o multipart existe) | `src/videos/video-uploads.service.integration-spec.ts` |

**Dependencies:** SI-03.4 (StorageService), SI-03.7 (VideosService, exceções, `ChannelsService.findByUserId`).

**Acceptance criteria:**

- `POST /videos` com `{ "file_name": "clip.mp4", "mime_type": "video/mp4", "size": 1048576 }` retorna `201` com `status: "draft"`, `slug` de 11 caracteres, `title: "clip"`, `upload.part_size: 67108864` e `upload.part_count: 1`.
- `POST /videos` com `size: 10737418240` retorna `201` com `upload.part_count: 160`.
- `POST /videos` com `size: 10737418241` retorna `400` com `error: "VIDEO_TOO_LARGE"` e nenhuma linha é criada em `videos`.
- `POST /videos` com `mime_type: "video/quicktime"`, ou com `file_name: "clip.webm"` e `mime_type: "video/mp4"`, retorna `400` com `error: "UNSUPPORTED_VIDEO_FORMAT"`.
- `POST /videos` sem `size` ou com propriedade desconhecida retorna `400` com `error: "VALIDATION_ERROR"`.
- `POST /videos` sem token retorna `401`.
- O vídeo criado tem `channel_id` igual ao canal do usuário autenticado.
- 15 requisições `POST /videos` seguidas no mesmo minuto não recebem `429`.

---

### SI-03.9 — Endpoint GET /videos/:id (leitura do dono)

**Route:** GET /videos/:id
**Test Specs:** see `nestjs-project/specs/videos-get.plan.md`
**Authorization:** Owner (não dono → 404 `VIDEO_NOT_FOUND`)

**Description:** Expor a leitura mínima de um vídeo pelo dono, em qualquer status, para acompanhar o processamento e obter o `slug` que forma a URL única do vídeo.

**Technical actions:**

1. Adicionar a `VideosController` `@Get(':id')` `findOne(@CurrentUser() user, @Param('id', ParseUUIDPipe) id)` → `VideosService.findOwnedOrFail(user.sub, id)` → `VideoResponseDto.fromEntity` (per `phase-03-videos/TD-15`, Note AMB-6).
2. Decorators OpenAPI: `@ApiOperation`, `@ApiResponse` 200 (`type: VideoResponseDto`), 400, 401, 404 (`VIDEO_NOT_FOUND`) com `ApiErrorEnvelope` (per `openapi-docs-nestjs/TD-01`).

**Tests:** _(empty — controller wiring sobre `VideosService.findOwnedOrFail`, já coberto em SI-03.7; cenários E2E no spec de /plan-test-specs)_

**Dependencies:** SI-03.8 — `VideosController` e `VideoResponseDto` existem.

**Acceptance criteria:**

- `GET /videos/:id` pelo dono de um vídeo recém-criado retorna `200` com `id`, `slug`, `status: "draft"`, `failure_reason: null`, `duration`/`width`/`height`/`size`/`metadata` nulos e `has_thumbnail: false`.
- `GET /videos/:id` de um vídeo em `failed` retorna `200` com o `failure_reason` preenchido.
- `GET /videos/:id` por outro usuário autenticado retorna `404` com `error: "VIDEO_NOT_FOUND"`, idêntico ao de um UUID inexistente.
- `GET /videos/abc` retorna `400` com `error: "VALIDATION_ERROR"`.
- `GET /videos/:id` sem token retorna `401`.

---

### SI-03.10 — Endpoint GET /videos/:id/upload (estado para retomada)

**Route:** GET /videos/:id/upload
**Test Specs:** see `nestjs-project/specs/videos-upload-status.plan.md`
**Authorization:** Owner, somente com o vídeo em `draft`

**Description:** Permitir que o cliente retome um upload interrompido descobrindo quais partes já estão no storage, sem guardar estado próprio — a retomada nativa do multipart S3.

**Technical actions:**

1. Adicionar `VideoUploadsService.getUploadStatus(userId, id)` — `findOwnedOrFail`; status ≠ `draft` → `InvalidVideoStatusException`; `StorageService.listParts(videoOriginalKey(id), upload_id)` (`null` → lista vazia); devolve `part_size`, `part_count` (derivado de `declared_size`) e `uploaded_parts` (`{ part_number, size }`) ordenado (per `phase-03-videos/TD-07`).
2. Criar `src/videos/dto/upload-status-response.dto.ts` conforme `### API Contracts → GET /videos/:id/upload`.
3. Adicionar a `VideosController` `@Get(':id/upload')` com `ParseUUIDPipe` e decorators OpenAPI (200 `UploadStatusResponseDto`, 400, 401, 404, 409 `INVALID_VIDEO_STATUS`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoUploadsService.getUploadStatus` | Unit: guarda de status (`processing`/`ready`/`failed` → `InvalidVideoStatusException`), `NoSuchUpload` → lista vazia, cálculo de `part_count` | `src/videos/video-uploads.service.spec.ts` |
| `VideoUploadsService.getUploadStatus` | Integration (MinIO real): após `PUT` das partes 1 e 3 via `presignUploadPart`, retorna exatamente essas partes com os tamanhos enviados | `src/videos/video-uploads.service.integration-spec.ts` |

**Dependencies:** SI-03.8 — `VideoUploadsService` e o vídeo em `draft` com multipart aberto.

**Acceptance criteria:**

- `GET /videos/:id/upload` de um rascunho recém-criado retorna `200` com `part_size: 67108864`, o `part_count` do vídeo e `uploaded_parts: []`.
- Depois do `PUT` das partes 1 e 3 nas URLs pré-assinadas, `GET /videos/:id/upload` retorna `uploaded_parts` com `part_number` 1 e 3 e os tamanhos enviados.
- `GET /videos/:id/upload` de um vídeo em `processing` retorna `409` com `error: "INVALID_VIDEO_STATUS"`.
- `GET /videos/:id/upload` por outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`.

---

### SI-03.11 — Endpoint POST /videos/:id/upload/part-urls (URLs pré-assinadas de partes)

**Route:** POST /videos/:id/upload/part-urls
**Test Specs:** see `nestjs-project/specs/videos-upload-part-urls.plan.md`
**Authorization:** Owner, somente com o vídeo em `draft`

**Description:** Entregar ao cliente, em lotes, as URLs pré-assinadas para enviar cada parte de 64 MiB direto ao storage — o plano de dados do upload de 10GB não passa pela API nem pelo BFF, então não afeta a performance do sistema.

**Technical actions:**

1. Adicionar `VideoUploadsService.presignParts(userId, id, partNumbers)` — `findOwnedOrFail`; status ≠ `draft` → `InvalidVideoStatusException`; algum número > `part_count` → `InvalidPartNumberException`; para cada número, `StorageService.presignUploadPart(videoOriginalKey(id), upload_id, n)` (cliente público, TTL `S3_UPLOAD_PART_URL_TTL_SECONDS`), preservando a ordem do pedido; devolve `{ expires_in, parts }` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-07`).
2. Criar `src/videos/dto/create-part-urls.dto.ts` (`part_numbers` com as regras de `#### Validation Rules — Videos`) e `src/videos/dto/part-urls-response.dto.ts`.
3. Adicionar a `VideosController` `@Post(':id/upload/part-urls')` + `@HttpCode(HttpStatus.OK)` com `ParseUUIDPipe` e decorators OpenAPI (200 `PartUrlsResponseDto`, 400 `VALIDATION_ERROR`/`INVALID_PART_NUMBER`, 401, 404, 409 `INVALID_VIDEO_STATUS`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoUploadsService.presignParts` | Unit: número acima de `part_count` → `InvalidPartNumberException`, guarda de status, ordem das URLs igual à de `part_numbers`, `expires_in` vindo da config | `src/videos/video-uploads.service.spec.ts` |
| `VideoUploadsService.presignParts` | Integration (MinIO real): `PUT` de 5 MiB na URL devolvida responde `200` com `ETag` e a parte aparece em `listParts` | `src/videos/video-uploads.service.integration-spec.ts` |

**Dependencies:** SI-03.8 — `VideoUploadsService` e o vídeo em `draft` com multipart aberto.

**Acceptance criteria:**

- `POST /videos/:id/upload/part-urls` com `{ "part_numbers": [1, 2] }` retorna `200` com `expires_in: 3600` (default) e duas URLs que começam com `S3_PUBLIC_ENDPOINT`, na ordem pedida.
- Um `PUT` com os bytes da parte em uma URL devolvida é aceito pelo storage (`200` com `ETag`).
- Com `S3_UPLOAD_PART_URL_TTL_SECONDS=600`, a resposta traz `expires_in: 600` e as URLs carregam `X-Amz-Expires=600`.
- `part_numbers` contendo um número maior que `part_count` retorna `400` com `error: "INVALID_PART_NUMBER"`.
- `part_numbers` vazio, com 101 itens, com duplicados ou com `0` retorna `400` com `error: "VALIDATION_ERROR"`.
- O pedido para um vídeo fora de `draft` retorna `409` com `error: "INVALID_VIDEO_STATUS"`; por outro usuário, `404` com `error: "VIDEO_NOT_FOUND"`.

---

### SI-03.12 — Endpoint POST /videos/:id/upload/complete (conclusão + disparo do processamento)

**Route:** POST /videos/:id/upload/complete
**Test Specs:** see `nestjs-project/specs/videos-upload-complete.plan.md`
**Authorization:** Owner; `draft` conclui, `processing`/`ready` é replay idempotente, `failed` → 409

**Description:** Concluir o multipart upload no storage, validar que o arquivo montado tem o tamanho declarado, mover o vídeo para `processing` e enfileirar o processamento automático — o gatilho único entre upload e worker.

**Technical actions:**

1. Adicionar `VideoUploadsService.complete(userId, id)` — `findOwnedOrFail`; `processing`/`ready` → devolve o vídeo atual sem efeitos (idempotente); `failed` → `InvalidVideoStatusException`; `draft` → `StorageService.listParts`: quando `null` (multipart já concluído antes de uma queda), `headObject(videoOriginalKey(id))` decide entre seguir para a validação de tamanho (objeto existe) e `UploadIncompleteException`; senão exige partes `1..part_count` contíguas e soma dos tamanhos = `declared_size`, ou lança `UploadIncompleteException` (vídeo continua `draft`) (per `phase-03-videos/TD-07`, `phase-03-videos/TD-08`).
2. `completeMultipartUpload` com os ETags do `listParts` em ordem crescente; `headObject` → `contentLength ≠ declared_size` ou > `MAX_VIDEO_SIZE_BYTES` → `deleteObject`, `markFailed(id, 'size_mismatch', 'draft')` e `UploadSizeMismatchException` (per `phase-03-videos/TD-07` Note).
3. `VideosService.markProcessing(id)`; `false` (o sweep venceu a corrida) → `InvalidVideoStatusException`; em seguida `VideoProcessingProducer.enqueue(id)` dentro de `try/catch` — falha de enqueue é logada (`warn`) e a resposta segue `200`, porque o sweep re-enfileira `processing` travado (per `phase-03-videos/TD-13`).
4. Adicionar a `VideosController` `@Post(':id/upload/complete')` + `@HttpCode(HttpStatus.OK)` com `ParseUUIDPipe` e decorators OpenAPI (200 `VideoResponseDto`, 400, 401, 404, 409 `UPLOAD_INCOMPLETE`/`UPLOAD_SIZE_MISMATCH`/`INVALID_VIDEO_STATUS`); `VideosModule` importa `VideoProcessingQueueModule`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoUploadsService.complete` | Unit: replay idempotente em `processing`/`ready`, `failed` → 409, parte faltando → `UploadIncompleteException`, soma ≠ declarado → `UploadIncompleteException`, `NoSuchUpload` + objeto presente → segue, tamanho divergente → delete + `markFailed('size_mismatch')`, transição perdida → `InvalidVideoStatusException`, falha de enqueue não propaga | `src/videos/video-uploads.service.spec.ts` |
| `VideoUploadsService.complete` | Integration (Postgres + MinIO + Redis reais): duas partes (64 MiB + resto) enviadas por URL pré-assinada → `complete` → linha em `processing` com `processing_started_at`, objeto `videos/{id}/original` com o tamanho declarado e job `process-video` com `jobId = videoId` na fila | `src/videos/video-uploads.service.integration-spec.ts` |

**Dependencies:** SI-03.5 (producer), SI-03.11 (partes enviadas por URL pré-assinada).

**Acceptance criteria:**

- Com todas as partes enviadas, `POST /videos/:id/upload/complete` retorna `200` com `status: "processing"`, e `GET /videos/:id` passa a mostrar `processing`.
- Após a conclusão, existe na fila `video-processing` um job `process-video` com `jobId` igual ao id do vídeo.
- Um segundo `POST /videos/:id/upload/complete` retorna `200` com o status atual e não cria outro job.
- Com uma parte faltando, a conclusão retorna `409` com `error: "UPLOAD_INCOMPLETE"`, o vídeo continua `draft` e `GET /videos/:id/upload` segue funcionando para retomar.
- A conclusão de um vídeo em `failed` retorna `409` com `error: "INVALID_VIDEO_STATUS"`.
- Com o Redis indisponível no momento do enqueue, a conclusão ainda retorna `200` e o vídeo fica em `processing`.
- A conclusão por outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`.

---

### SI-03.13 — Endpoints de entrega: streaming, download e thumbnail

**Route:** GET /videos/:id/stream, GET /videos/:id/download, GET /videos/:id/thumbnail
**Test Specs:** see `nestjs-project/specs/videos-delivery.plan.md`
**Authorization:** Owner, somente com o vídeo em `ready`

**Description:** Entregar reprodução via streaming (sem download completo — `Range`/`206` nativo do storage) e download do vídeo pelo dono, além do acesso à thumbnail, redirecionando para URLs pré-assinadas de curta duração sem consumir banda da API.

**Technical actions:**

1. Criar `src/videos/video-delivery.service.ts` — `getStreamUrl(userId, id)`, `getDownloadUrl(userId, id)` e `getThumbnailUrl(userId, id)`: `findOwnedOrFail` primeiro (não dono → 404), depois `status ≠ ready` (ou `has_thumbnail = false` na thumbnail) → `VideoNotReadyException`; então `StorageService.presignGet` em `videoOriginalKey(id)` / `videoThumbnailKey(id)` (cliente público, TTL `S3_DELIVERY_URL_TTL_SECONDS`) (per `phase-03-videos/TD-15`, `phase-03-videos/TD-05`).
2. Criar `src/videos/content-disposition.util.ts` — `buildAttachmentDisposition(filename)` → `attachment; filename="<fallback ASCII>"; filename*=UTF-8''<percent-encoded>` (no fallback, caracteres não ASCII, aspas, barra invertida e de controle viram `_`), usado como `responseContentDisposition` do download.
3. Adicionar a `VideosController` `@Get(':id/stream')`, `@Get(':id/download')` e `@Get(':id/thumbnail')` com `ParseUUIDPipe`, `@Redirect()` dinâmico (o handler devolve `{ url, statusCode: 302 }`) e `@Header('Cache-Control', 'private, no-store')`.
4. Decorators OpenAPI das três rotas: `@ApiOperation`, `@ApiResponse` 302 com `headers: { Location: { schema: { type: 'string', format: 'uri' } } }`, 400, 401, 404 (`VIDEO_NOT_FOUND`), 409 (`VIDEO_NOT_READY`) com `ApiErrorEnvelope`; prover `VideoDeliveryService` em `VideosModule`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `buildAttachmentDisposition` | Unit: nome ASCII simples, nome com acentos/emoji (fallback + `filename*`), aspas e barra invertida neutralizadas | `src/videos/content-disposition.util.spec.ts` |
| `VideoDeliveryService` | Unit: checagem de dono antes do status (não dono de vídeo `draft` → `VideoNotFoundException`, não `VideoNotReadyException`), `draft`/`processing`/`failed` → `VideoNotReadyException`, `has_thumbnail = false` → `VideoNotReadyException` | `src/videos/video-delivery.service.spec.ts` |
| `VideoDeliveryService` | Integration (Postgres + MinIO reais): objeto gravado em `videos/{id}/original` → URL de stream atende `Range` com `206`; URL de download responde com `Content-Disposition: attachment`; URL da thumbnail responde `image/jpeg` | `src/videos/video-delivery.service.integration-spec.ts` |

**Dependencies:** SI-03.9 — `VideosController` com leitura do dono.

**Acceptance criteria:**

- `GET /videos/:id/stream` de um vídeo `ready` do dono retorna `302` com `Location` começando em `S3_PUBLIC_ENDPOINT`, `X-Amz-Expires=14400` (default) e `Cache-Control: private, no-store`.
- Um `GET` no `Location` do stream com `Range: bytes=0-1023` retorna `206` com `Content-Range` e 1024 bytes.
- O `Location` de `GET /videos/:id/download` responde com `Content-Disposition: attachment` contendo o `original_filename`.
- O `Location` de `GET /videos/:id/thumbnail` responde `200` com `Content-Type: image/jpeg`.
- Stream, download ou thumbnail de um vídeo em `draft`, `processing` ou `failed` retorna `409` com `error: "VIDEO_NOT_READY"`.
- Stream, download ou thumbnail por outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`, mesmo quando o vídeo não está `ready`.
- Com `S3_DELIVERY_URL_TTL_SECONDS=7200`, os `Location` carregam `X-Amz-Expires=7200`.

---

### SI-03.14 — MediaToolsService: wrapper tipado de ffprobe/ffmpeg

**Description:** Encapsular os dois comandos de FFmpeg que a fase precisa — extração de metadados e captura de um frame — atrás de um serviço injetável que roda os binários em processo filho (sem bloquear o event loop do worker) e classifica erros em permanentes e transitórios.

**Technical actions:**

1. Criar `src/video-processing/media/media-tools.service.ts` — `probe(input: string): Promise<ProbeResult>` com `execFile('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', input], { timeout: 60_000, maxBuffer })`, sem shell e com stderr capturado (per `phase-03-videos/TD-11`; `input` é uma URL pré-assinada interna — per `phase-03-videos/TD-12` — ou um caminho local nos testes).
2. Criar `src/video-processing/media/probe-parser.ts` — `parseProbeOutput(json)` puro: `duration`, `size`, `format_name` e `bit_rate` de `format`; `width`, `height`, `codec_name` e `avg_frame_rate` (fração `"30000/1001"` → número; `"0/0"` → `null`) do primeiro stream de vídeo; `codec_name` do primeiro stream de áudio ou `null`; sem stream de vídeo → `MediaToolError('invalid_media')`.
3. Adicionar `extractFrame(input, atSeconds): Promise<Buffer>` — `execFile('ffmpeg', ['-v', 'error', ...reconnectFlags, '-ss', String(atSeconds), '-i', input, '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'], { encoding: 'buffer', timeout: 120_000 })`; `reconnectFlags` (`-reconnect 1 -reconnect_on_network_error 1 -reconnect_on_http_error 5xx`) só quando `input` é `http(s)://` (per `phase-03-videos/TD-11` Note AMB-3, `phase-03-videos/TD-12`).
4. Criar `src/video-processing/media/media-tool-error.ts` — `MediaToolError { kind: 'invalid_media' | 'transient' }` e `classifyFfmpegFailure(stderr, error)`: `Invalid data found when processing input`, `moov atom not found`, `EBML header parsing failed` → `invalid_media`; HTTP 5xx, conexão recusada/resetada, timeout (processo morto) e demais → `transient`.
5. Criar `src/test/video-fixtures.ts` — gera clipes com `ffmpeg -f lavfi` em diretório temporário: MP4 H.264+AAC 3 s 320x240 25 fps, WebM VP9+Opus, MP4 sem áudio, MP4 de 0,5 s, MP4 1920x1080, MPEG-4 Part 2 (`-c:v mpeg4`) em contêiner MP4 (codec fora da allowlist) e um arquivo `.mp4` truncado/corrompido; remove o diretório no `cleanup()`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `parseProbeOutput` | Unit: fração de frame rate, `"0/0"` → `null`, áudio ausente → `null`, sem stream de vídeo → `invalid_media` | `src/video-processing/media/probe-parser.spec.ts` |
| `classifyFfmpegFailure` | Unit: padrões de stderr permanentes vs transitórios, timeout → `transient` | `src/video-processing/media/media-tool-error.spec.ts` |
| `MediaToolsService` | Integration (ffprobe/ffmpeg reais + MinIO): metadados do MP4 e do WebM de fixture, `probe` por URL pré-assinada interna do MinIO, frame JPEG (`FF D8`) de 1280x720 a partir do 1920x1080, arquivo corrompido → `invalid_media`, URL inexistente/inalcançável → erro classificado | `src/video-processing/media/media-tools.service.integration-spec.ts` |

**Dependencies:** SI-03.1 (FFmpeg na imagem), SI-03.4 (URL pré-assinada interna para o teste por HTTP).

**Acceptance criteria:**

- `probe` de um MP4 H.264/AAC de 3 s, 320x240, 25 fps retorna `duration ≈ 3`, `width = 320`, `height = 240`, `video_codec = "h264"`, `audio_codec = "aac"`, `frame_rate = 25` e `format_name` contendo `mp4`.
- `probe` de um WebM VP9/Opus retorna `video_codec = "vp9"`, `audio_codec = "opus"` e `format_name` contendo `webm`; de um MP4 sem áudio, `audio_codec = null`.
- `probe` funciona com uma URL pré-assinada do MinIO como entrada, sem baixar o arquivo para disco.
- `extractFrame` de um vídeo 1920x1080 devolve um JPEG de 1280x720; de um vídeo 320x240, um JPEG de 320x240.
- `probe` de um arquivo corrompido falha com erro `invalid_media`; uma URL de storage inalcançável falha com erro `transient`.

---

### SI-03.15 — VideoProcessingService: extração de metadados e geração de thumbnail

**Description:** Implementar a regra de negócio do processamento automático — confirmar que o arquivo real é reproduzível no browser, extrair duração e metadados, gerar a thumbnail a partir de um frame e marcar o vídeo como `ready` — independente do mecanismo de fila.

**Technical actions:**

1. Criar `src/video-processing/video-processing-errors.ts` — `PermanentProcessingError` com `reason: 'unsupported_format' | 'invalid_media'` — e `src/video-processing/playback-allowlist.ts` — `assertPlayable(declaredMimeType, probe)` puro: `video/mp4` exige `format_name` contendo `mp4`, vídeo `h264` e áudio `aac`/`mp3`/ausente; `video/webm` exige `format_name` contendo `webm`, vídeo `vp8`/`vp9`/`av1` e áudio `opus`/`vorbis`/ausente; qualquer divergência → `PermanentProcessingError('unsupported_format')` (per `phase-03-videos/TD-09` Note).
2. Criar `src/video-processing/video-processing.service.ts` — `process(videoId)`: `VideosService.findById`; vídeo ausente ou fora de `processing` → log e retorno sem efeito (idempotência at-least-once); `StorageService.presignInternalGet(videoOriginalKey(id))` como entrada de leitura por range (per `phase-03-videos/TD-12`); `MediaToolsService.probe`; `MediaToolError('invalid_media')` → `PermanentProcessingError('invalid_media')`; `assertPlayable`.
3. Thumbnail: `t = duration < 1 ? 0 : duration * 0.1`; `MediaToolsService.extractFrame(url, t)`; `StorageService.putObject(videoThumbnailKey(id), jpeg, 'image/jpeg')` (per `phase-03-videos/TD-11` Note AMB-3).
4. Persistência: `StorageService.headObject(videoOriginalKey(id))` → `size`; `VideosService.markReady(id, { duration, width, height, size, metadata: { video_codec, audio_codec, format_name, bit_rate, frame_rate }, has_thumbnail: true })` condicional a `processing`. Erros transitórios (`MediaToolError('transient')`, falhas de storage) são relançados sem conversão para que o BullMQ aplique retry (per `phase-03-videos/TD-13`).
5. Criar `src/video-processing/video-processing.module.ts` — `VideoProcessingModule` (sem `@Processor`) importando `VideosModule` e `StorageModule`, provendo `MediaToolsService` e `VideoProcessingService`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `assertPlayable` | Unit: matriz de combinações aceitas/rejeitadas por MIME declarado (inclui WebM declarado como `video/mp4` e `mpeg4` em MP4) | `src/video-processing/playback-allowlist.spec.ts` |
| `VideoProcessingService` | Unit: vídeo ausente/`ready`/`failed` → sem efeito, timestamp 0 para duração < 1 s e 10% nos demais, `invalid_media` → `PermanentProcessingError`, erro transitório relançado sem conversão | `src/video-processing/video-processing.service.spec.ts` |
| `VideoProcessingService` | Integration (Postgres + MinIO + FFmpeg reais): fixture MP4 e WebM gravadas em `videos/{id}/original` com a linha em `processing` → linha `ready` com `duration`/`width`/`height`/`size`/`metadata` e `thumbnail.jpg` presente; MPEG-4 Part 2 declarado `video/mp4` → `unsupported_format` sem thumbnail gravada; arquivo corrompido → `invalid_media` | `src/video-processing/video-processing.service.integration-spec.ts` |

**Dependencies:** SI-03.7 (transições do `VideosService`), SI-03.14 (`MediaToolsService`).

**Acceptance criteria:**

- Processar um vídeo `processing` com um MP4 H.264/AAC válido deixa a linha em `ready` com `duration`, `width`, `height`, `size` (igual ao objeto armazenado), `metadata` com os cinco campos e `has_thumbnail = true`.
- O objeto `videos/{videoId}/thumbnail.jpg` existe com `Content-Type: image/jpeg` e largura ≤ 1280 px.
- Para um vídeo de 0,5 s, a thumbnail é o frame em 0 s; para um de 10 s, o frame em 1 s.
- Um arquivo com codec fora da allowlist, ou cujo contêiner real diverge do MIME declarado, resulta em erro permanente `unsupported_format` e nenhuma thumbnail é gravada.
- Processar de novo um vídeo já `ready` não altera a linha nem o storage.

---

### SI-03.16 — Runtime do worker: consumer BullMQ, entrypoint separado e serviço Compose `video-worker`

**Description:** Colocar o processamento em segundo plano para rodar em um container separado da API — mesma base de código, entrypoint próprio sem servidor HTTP — consumindo a fila `video-processing` com retry, falhas permanentes e mapeamento final para `failed`.

**Technical actions:**

1. Criar `src/video-processing/video-processing.consumer.ts` — `@Processor(VIDEO_PROCESSING_QUEUE, { concurrency: 1 })` estendendo `WorkerHost`; `process(job: Job<ProcessVideoJobData>)` chama `VideoProcessingService.process(job.data.videoId)` e converte `PermanentProcessingError` em `throw new UnrecoverableError(reason)`; `@OnWorkerEvent('failed')` marca `VideosService.markFailed(videoId, reason, 'processing')` somente quando o erro é `UnrecoverableError` (reason = mensagem), `job.attemptsMade >= job.opts.attempts` ou a mensagem indica "stalled more than allowable limit" (reason = `processing_error`) (per `phase-03-videos/TD-13`, `phase-03-videos/TD-01`).
2. Criar `src/video-processing/video-processing-worker.module.ts` — `VideoProcessingWorkerModule` importando `VideoProcessingModule` e `VideoProcessingQueueModule`, provendo o consumer; importado **apenas** pelo `WorkerModule` (per `phase-03-videos/TD-02`).
3. Criar `src/worker.module.ts` (`ConfigModule.forRoot(configModuleOptions)`, `DatabaseModule`, `QueueModule`, `VideoProcessingWorkerModule`) e `src/worker.ts` — `NestFactory.createApplicationContext(WorkerModule)`, `app.enableShutdownHooks()` (SIGTERM fecha workers e filas) e log de prontidão.
4. Adicionar scripts em `package.json`: `start:worker` (`node dist/worker`) e `start:worker:dev` (`node --watch -r ts-node/register -r tsconfig-paths/register src/worker.ts`) — evita dois `nest start --watch` disputando o `dist/` com `deleteOutDir: true`.
5. Adicionar a `compose.yaml` o serviço `video-worker` — `build` com o mesmo `Dockerfile.dev`, volume `.:/home/node/app`, `command: npm run start:worker:dev`, `restart: unless-stopped`, sem portas, `depends_on` `db` (`service_healthy`), `redis` (`service_healthy`) e `minio-init` (`service_completed_successfully`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingConsumer` | Unit: `PermanentProcessingError` → `UnrecoverableError` com o reason; matriz do evento `failed` (tentativa intermediária → não marca; última tentativa → `processing_error`; `UnrecoverableError` → reason; stalled → `processing_error`) | `src/video-processing/video-processing.consumer.spec.ts` |
| `VideoProcessingConsumer` | Integration (Redis + Postgres + MinIO + FFmpeg reais, prefixo de fila único): job de vídeo válido → linha `ready`; job de vídeo com codec fora da allowlist → linha `failed` com `unsupported_format` e `attemptsMade = 1` | `src/video-processing/video-processing.consumer.integration-spec.ts` |
| `WorkerModule` | Integration: `createApplicationContext(WorkerModule)` inicializa sem servidor HTTP, registra exatamente um worker para `video-processing` e fecha limpo | `src/worker.module.integration-spec.ts` |

**Dependencies:** SI-03.3 (opções compartilhadas + `DatabaseModule`), SI-03.5 (fila e contratos), SI-03.15 (`VideoProcessingService`).

**Acceptance criteria:**

- `docker compose up -d` sobe o `video-worker` junto com o backend, e `docker compose logs video-worker` mostra o worker pronto sem abrir porta HTTP.
- Com a stack de dev, enviar e concluir um MP4 válido pela API leva o vídeo a `ready` (visível em `GET /videos/:id`) sem nenhuma ação manual.
- Um vídeo com codec fora da allowlist termina em `failed` com `failure_reason: "unsupported_format"` após uma única tentativa.
- Um erro transitório (storage indisponível durante o job) é retentado com backoff exponencial; esgotadas as 5 tentativas, o vídeo vai para `failed` com `processing_error`.
- Com o `video-worker` parado, um upload concluído deixa o job esperando na fila — a API não consome jobs; ao religar o worker, o vídeo é processado.
- `docker compose stop video-worker` encerra o processo de forma limpa (SIGTERM fecha worker e conexões).

---

### SI-03.17 — Sweep de reconciliação: job scheduler `reconcile-videos`

**Description:** Fechar as lacunas do pipeline assíncrono com um único mecanismo periódico: abortar e marcar como `failed` os rascunhos abandonados e re-enfileirar vídeos travados em `processing` (dual-write entre banco e fila, callback de conclusão perdido).

**Technical actions:**

1. Criar `src/video-processing/reconciliation/reconciliation.constants.ts` (`ABANDONED_DRAFT_AFTER_MS = 24h`, `STUCK_PROCESSING_AFTER_MS = 1h`, `RECONCILE_EVERY_MS = 900000`, `RECONCILE_BATCH_LIMIT = 100`) e `video-reconciliation.service.ts` — `run(now = new Date())`: para cada `VideosService.findAbandonedDrafts(now − 24h, 100)`, `StorageService.abortMultipartUpload(videoOriginalKey(id), upload_id)` (`NoSuchUpload` = já abortado) e `markFailed(id, 'upload_abandoned', 'draft')`; erro de abort diferente de `NoSuchUpload` é logado e o vídeo fica para o próximo run; para cada `findStuckProcessing(now − 1h, 100)`, `VideoProcessingProducer.enqueue(id)`; devolve `{ abandoned, requeued }` (per `phase-03-videos/TD-13` Note AMB-5, `phase-03-videos/TD-10` Note AMB-5).
2. Criar `src/video-processing/reconciliation/video-reconciliation.consumer.ts` — `@Processor(VIDEO_RECONCILIATION_QUEUE, { concurrency: 1 })` estendendo `WorkerHost`, chamando `VideoReconciliationService.run()` e logando as contagens.
3. Criar `src/video-processing/reconciliation/video-reconciliation.scheduler.ts` — `OnApplicationBootstrap` executa `queue.upsertJobScheduler(RECONCILE_SCHEDULER_ID, { every: RECONCILE_EVERY_MS }, { name: RECONCILE_JOB, data: {}, opts: { removeOnComplete: true, removeOnFail: 100 } })` (per `phase-03-videos/TD-13`).
4. Registrar em `VideoProcessingWorkerModule`: `BullModule.registerQueue({ name: VIDEO_RECONCILIATION_QUEUE })`, `VideoReconciliationService`, `VideoReconciliationConsumer` e `VideoReconciliationScheduler` (somente no worker).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoReconciliationService` | Unit: limiares calculados a partir do `now` injetado, erro de abort diferente de `NoSuchUpload` não marca `failed` e não interrompe os demais vídeos, contagens retornadas | `src/video-processing/reconciliation/video-reconciliation.service.spec.ts` |
| `VideoReconciliationService` | Integration (Postgres + MinIO + Redis reais): draft de 25 h com multipart real → `failed`/`upload_abandoned` e `listParts` = `null`; draft de 23 h intacto; draft cujo multipart já foi abortado → `failed`; `processing` há 2 h → job enfileirado; `processing` há 30 min → nada; `processing` há 2 h com job ainda existente → sem duplicata; vídeo que passou a `processing` antes do update → não sobrescrito | `src/video-processing/reconciliation/video-reconciliation.service.integration-spec.ts` |
| `VideoReconciliationScheduler` | Integration (Redis real): dois bootstraps seguidos deixam exatamente um scheduler `reconcile-videos` com `every = 900000` em `getJobSchedulers()` | `src/video-processing/reconciliation/video-reconciliation.scheduler.integration-spec.ts` |

**Dependencies:** SI-03.16 — runtime do worker e `VideoProcessingWorkerModule`.

**Acceptance criteria:**

- Um rascunho criado há mais de 24 horas passa a `failed` com `failure_reason: "upload_abandoned"` no próximo run, a linha é mantida e o multipart upload deixa de existir no storage.
- Um rascunho com menos de 24 horas não é alterado.
- Um vídeo em `processing` há mais de 1 hora sem job na fila ganha um novo job `process-video` com `jobId` igual ao id do vídeo; com job ainda na fila, nenhum job extra é criado.
- Uma conclusão de upload que vence a corrida contra o sweep mantém o vídeo em `processing` (o sweep não sobrescreve).
- Após `docker compose restart video-worker`, o Redis contém exatamente um job scheduler `reconcile-videos` com intervalo de 15 minutos.

---

### SI-03.18 — E2E do pipeline completo: upload → processamento → streaming/download

**Description:** Provar os entregáveis da fase de ponta a ponta, sem mocks: upload multipart real em duas partes por URLs pré-assinadas, retomada, processamento pelo worker real (Redis + FFmpeg), e entrega por streaming com `Range`, download e thumbnail.

**Technical actions:**

1. Reutilizar `test/helpers/auth.helper.ts` (`createAuthenticatedUser(app)`, extraído em SI-03.8) no novo arquivo.
2. Criar `test/videos-pipeline.e2e-spec.ts` — sobe o `AppModule` HTTP (mesmos pipes/filtros de `main.ts`) e, no mesmo processo, `NestFactory.createApplicationContext(WorkerModule)` com o prefixo de teste `streamtube-test`; `obliterate` das filas no `beforeAll`/`afterAll`; timeout de 180 s por teste.
3. Cenário feliz: fixture MP4 H.264/AAC maior que 64 MiB (ex.: `testsrc2` 1280x720 com `-qp 0` por alguns segundos) → `POST /videos` (`part_count: 2`) → `POST .../part-urls` `[1, 2]` → `PUT` das duas fatias com `fetch` → `POST .../complete` → polling de `GET /videos/:id` até `ready` → `GET .../stream` (302) + `GET` no `Location` com `Range` (206) → `GET .../download` (302, `Content-Disposition: attachment`) → `GET .../thumbnail` (302, JPEG).
4. Cenário de retomada: envia só a parte 1, descarta o estado do cliente, `GET /videos/:id/upload` lista a parte 1, pede URL só da parte 2, envia, conclui → `ready`. Cenário de falha: MP4 com vídeo MPEG-4 Part 2 declarado `video/mp4` → `failed` com `unsupported_format` e `GET .../stream` → `409 VIDEO_NOT_READY`.
5. Limpeza: `StorageService.deletePrefix(videoPrefix(id))` para cada vídeo criado, `cleanAllTables`, fechamento do contexto do worker e da aplicação.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Pipeline de vídeo (API + worker) | E2E (supertest + `fetch` contra MinIO, Redis, Postgres e FFmpeg reais): upload em 2 partes, retomada, processamento até `ready`, stream com `Range`/206, download com `attachment`, thumbnail JPEG, falha `unsupported_format` | `test/videos-pipeline.e2e-spec.ts` |

**Dependencies:** SI-03.12 (conclusão + enqueue), SI-03.13 (entrega), SI-03.16 (worker).

**Acceptance criteria:**

- Um MP4 válido com mais de 64 MiB enviado em 2 partes direto ao storage chega a `ready` sem que nenhum byte do vídeo passe pela API, com `duration`, `width = 1280`, `height = 720`, `size` igual ao arquivo enviado e `has_thumbnail: true`.
- Interrompido após a parte 1, o upload é retomado só com a parte 2 e o vídeo chega a `ready`.
- O vídeo `ready` é reproduzível por streaming (`206` para `Range: bytes=0-1048575`), baixável (`Content-Disposition: attachment` com o nome original) e tem thumbnail JPEG com largura ≤ 1280.
- O `slug` de cada vídeo criado no teste é distinto dos demais.
- Um MP4 com codec fora da allowlist termina em `failed` com `unsupported_format`, e o stream desse vídeo retorna `409 VIDEO_NOT_READY`.
- A suíte `npm run test:e2e` completa passa com o `video-worker` de dev ligado ao mesmo tempo (isolamento pelo prefixo de fila).

---

### SI-03.19 — OpenAPI: completar schemas de vídeos e regenerar `openapi.json`

**Description:** Garantir que o contrato HTTP de vídeos que o frontend vai consumir via codegen esteja completo e versionado no `openapi.json` commitado, com operações, respostas por status, redirects e envelope de erro documentados.

**Technical actions:**

1. Revisar os DTOs de `src/videos/dto/` — `@ApiProperty` explícito para todos os campos que o plugin não infere (`nullable: true` em `failure_reason`/`duration`/`width`/`height`/`size`/`metadata`, `enum: VideoStatus` em `status`, `type: VideoMetadataDto`, `type: [UploadedPartDto]`/`[PartUrlDto]` nos arrays) e `@ApiExtraModels` onde houver `$ref` manual (per `openapi-docs-nestjs/TD-01`, Revisions 2026-05-12).
2. Regenerar `nestjs-project/openapi.json` com `docker compose exec nestjs-api npm run openapi:export` e versionar o arquivo (per `openapi-docs-nestjs/TD-02`).
3. Estender `src/openapi-export.integration-spec.ts` — o documento contém as oito operações de `### API Contracts` (`/videos`, `/videos/{id}`, `/videos/{id}/upload`, `/videos/{id}/upload/part-urls`, `/videos/{id}/upload/complete`, `/videos/{id}/stream`, `/videos/{id}/download`, `/videos/{id}/thumbnail`) com segurança `access-token` e tag `videos`, o schema `VideoResponseDto` com o enum de `status`, e as respostas `302` com header `Location`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `exportSpec` | Integration: presença das operações de vídeos, segurança, enum de `status`, respostas 302 com `Location` e erros referenciando `ApiErrorEnvelope` | `src/openapi-export.integration-spec.ts` |

**Dependencies:** SI-03.12, SI-03.13 — todas as rotas de vídeo existem.

**Acceptance criteria:**

- `nestjs-project/openapi.json` versionado contém as oito operações de vídeos sob a tag `videos`, todas exigindo o esquema `access-token`.
- Cada operação de vídeo documenta suas respostas de erro com o schema `ApiErrorEnvelope` e os códigos do `### Error Catalog` aplicáveis.
- `VideoResponseDto` no documento declara `status` com os valores `draft`, `processing`, `ready`, `failed` e os campos de processamento como `nullable`.
- Rodar `npm run openapi:export` de novo sem mudanças de código não gera diff no `openapi.json`.
- Com `SWAGGER_ENABLED=true`, `/api/docs` lista os endpoints de vídeos.

---

### SI-03.20 — Documentação: seção de vídeos nos CLAUDE.md e estratégia de testes de storage/fila

**Description:** Registrar para os próximos agentes e desenvolvedores como a infraestrutura de vídeos sobe, é verificada e é testada, e alinhar o guia de testes à decisão de usar MinIO e Redis reais.

**Technical actions:**

1. Adicionar ao **final** de `nestjs-project/CLAUDE.md` uma seção `## Videos`: serviços (`minio` 9000 API / 9001 console, `minio-init` one-shot, `redis` 6379, `video-worker` sem porta) e checagens de prontidão (`docker compose ps`, `docker compose exec redis redis-cli ping`, `docker compose logs minio-init`, `docker compose logs video-worker`); variáveis `S3_*` (incluindo `S3_UPLOAD_PART_URL_TTL_SECONDS`=3600 e `S3_DELIVERY_URL_TTL_SECONDS`=14400), `REDIS_*` e `QUEUE_PREFIX`; fluxo HTTP (iniciar → part-urls → `PUT` direto no storage → complete → polling → stream/download/thumbnail); comandos `start:worker` / `start:worker:dev`; isolamento de testes (`QUEUE_PREFIX=streamtube-test`, `S3_PUBLIC_ENDPOINT=http://minio:9000`, MinIO/Redis/FFmpeg reais, sem mocks); notas de produção (AWS S3 sem `S3_ENDPOINT`, CORS do bucket com `PUT`/`GET` e `ExposeHeaders: ETag`, regra de lifecycle `AbortIncompleteMultipartUpload` como defesa em profundidade — per `phase-03-videos/TD-13`).
2. Adicionar ao **final** do `CLAUDE.md` da raiz uma seção `## Videos` com o resumo da arquitetura da fase (fila = BullMQ sobre Redis; storage = MinIO `pgsty/minio` local / S3 em produção, bucket privado `videos/{videoId}/…`; `video-worker` = mesma base de código com entrypoint próprio; entrega por URL pré-assinada) e o link para `docs/phases/phase-03-videos/phase-03-videos.md`; atualizar o item `Message Queue (TBD)` da seção de arquitetura para `Message Queue (BullMQ on Redis)` (per `phase-03-videos/TD-01`).
3. Atualizar `.claude/skills/testing-guide-nestjs-project/references/external-systems.md` — a seção "Object Storage — Local Filesystem" passa a "Object Storage — Real (MinIO in Docker)" (bucket criado pelo `minio-init`, limpeza por prefixo `videos/{id}/`, URLs pré-assinadas exercitadas com `fetch` dentro do container) e a seção de fila documenta BullMQ com prefixo isolado por suíte e `obliterate` no `afterAll`.

**Tests:** _(empty — documentação; os comandos documentados são verificados pelos critérios de aceite)_

**Dependencies:** SI-03.18, SI-03.19 — documenta o comportamento final verificado.

**Acceptance criteria:**

- `nestjs-project/CLAUDE.md` e o `CLAUDE.md` da raiz terminam com uma seção `## Videos`.
- Cada comando de prontidão listado na seção de `nestjs-project/CLAUDE.md` executa com sucesso em uma stack recém-subida com `docker compose up -d`.
- O `CLAUDE.md` da raiz não descreve mais a fila como "TBD".
- O guia de testes não recomenda mais storage em filesystem local para testes de storage.

---

## Technical Specifications

### Data Model

#### Video

Tabela `videos` (entity `Video` em `src/videos/entities/video.entity.ts`), criada pela migration `CreateVideos` (SI-03.6). O vídeo pertence ao **canal** do usuário que fez o upload (per `phase-03-videos/TD-10`, Note AMB-2).

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, `DEFAULT uuid_generate_v4()`; gerado na aplicação (`randomUUID()`) antes do `CreateMultipartUpload`, porque compõe a chave do objeto (per `phase-03-videos/TD-06`) |
| channel_id | uuid | not null, FK → `channels(id)` `ON DELETE CASCADE`, indexed |
| slug | varchar(11) | not null, **unique** — 11 caracteres base64url aleatórios (`randomBytes(8).toString('base64url')`) (per `phase-03-videos/TD-14`) |
| title | varchar(100) | not null — informado pelo cliente (opcional); default = nome original do arquivo sem extensão, truncado em 100 caracteres (per `phase-03-videos/TD-10`) |
| original_filename | varchar(255) | not null — nome original do arquivo declarado no início do upload |
| mime_type | varchar(50) | not null — MIME declarado; um de `video/mp4`, `video/webm` (per `phase-03-videos/TD-09`) |
| declared_size | bigint | not null, > 0, ≤ 10737418240 — tamanho declarado em bytes (per `phase-03-videos/TD-07`); transformer bigint ↔ `number` |
| upload_id | text | not null — `UploadId` do multipart upload S3 (per `phase-03-videos/TD-07`) |
| status | enum `videos_status_enum` (`draft`, `processing`, `ready`, `failed`) | not null, default `draft` (per `phase-03-videos/TD-10`) |
| failure_reason | varchar(50) | nullable — preenchido somente quando `status = failed`; valores em **Failure reasons** abaixo |
| processing_started_at | timestamp | nullable — gravado na transição `draft → processing`; base do critério "processing há mais de 1 hora" do sweep (per `phase-03-videos/TD-13`) |
| duration | numeric(10,3) | nullable — segundos; null até o processamento terminar (per `phase-03-videos/TD-11`); transformer numeric ↔ `number` |
| width | integer | nullable (per `phase-03-videos/TD-11`) |
| height | integer | nullable (per `phase-03-videos/TD-11`) |
| size | bigint | nullable — tamanho real armazenado em bytes, gravado pelo worker (per `phase-03-videos/TD-11`, `phase-03-videos/TD-06`); transformer bigint ↔ `number` |
| metadata | jsonb | nullable — `{ video_codec: string, audio_codec: string \| null, format_name: string, bit_rate: number \| null, frame_rate: number \| null }` (per `phase-03-videos/TD-11`) |
| has_thumbnail | boolean | not null, default `false` — `true` após o worker gravar `videos/{videoId}/thumbnail.jpg` (per `phase-03-videos/TD-15`) |
| created_at | timestamp | not null, default `now()` (`@CreateDateColumn`) |
| updated_at | timestamp | not null, default `now()` (`@UpdateDateColumn`) |

**Relations:** `Channel` has many `Video` (one-to-many); `Video` → `Channel` many-to-one via `channel_id` (`@ManyToOne` + `@JoinColumn({ name: 'channel_id' })`). A propriedade inversa em `Channel` não é adicionada nesta fase.
**Indexes:** unique on `slug`; index on `channel_id`; index composto on (`status`, `created_at`) para as consultas do sweep de reconciliação.
**Enum types:** `videos_status_enum` — deve entrar em `MANAGED_ENUM_TYPES` de `src/database/migrations.integration-spec.ts`.

**Status lifecycle** (per `phase-03-videos/TD-10`, `phase-03-videos/TD-13`) — toda transição é um `UPDATE ... WHERE id = :id AND status = :expected` (condicional; 0 linhas afetadas = transição perdida para uma concorrente):

| From | To | Owner da transição | Condição |
|------|----|--------------------|----------|
| — | `draft` | `VideoUploadsService.initiate` (API) | `POST /videos` aceito |
| `draft` | `processing` | `VideoUploadsService.complete` (API) | partes completas + `CompleteMultipartUpload` + `HeadObject` com tamanho igual ao declarado; grava `processing_started_at = now()` |
| `draft` | `failed` (`upload_abandoned`) | `VideoReconciliationService` (worker) | draft com `created_at` há mais de 24h |
| `draft` | `failed` (`size_mismatch`) | `VideoUploadsService.complete` (API) | tamanho armazenado ≠ `declared_size` após o `CompleteMultipartUpload` |
| `processing` | `ready` | `VideoProcessingService` (worker) | ffprobe + thumbnail OK; grava `duration`, `width`, `height`, `size`, `metadata`, `has_thumbnail = true` |
| `processing` | `failed` | `VideoProcessingConsumer` (worker, evento `failed`) | erro permanente (`UnrecoverableError`) ou tentativas esgotadas |

**Failure reasons** (`failure_reason`, string legível por máquina):

| Value | Origem |
|-------|--------|
| `upload_abandoned` | sweep: draft incompleto 24h após a criação (per `phase-03-videos/TD-10`, `phase-03-videos/TD-13`) |
| `size_mismatch` | completion: objeto armazenado com tamanho diferente do declarado ou acima de 10 GiB (per `phase-03-videos/TD-07`) |
| `unsupported_format` | worker: container/codecs reais fora da allowlist ou divergentes do MIME declarado (per `phase-03-videos/TD-09`) |
| `invalid_media` | worker: ffprobe falha com erro de dados inválidos ou o arquivo não tem stream de vídeo (per `phase-03-videos/TD-13`) |
| `processing_error` | worker: erro transitório que esgotou as tentativas, ou job "stalled" além do limite (per `phase-03-videos/TD-13`) |

#### Object Storage layout

Um bucket privado (`S3_BUCKET`, default `streamtube-videos`) com prefixo por vídeo (per `phase-03-videos/TD-06`):

| Key | Conteúdo | Escrito por |
|-----|----------|-------------|
| `videos/{videoId}/original` | arquivo de vídeo original (multipart upload; `ContentType` = `mime_type` declarado) | browser via URLs pré-assinadas de `UploadPart` (per `phase-03-videos/TD-07`) |
| `videos/{videoId}/thumbnail.jpg` | JPEG de um frame em 10% da duração (0 s quando a duração < 1 s), largura máxima 1280 px mantendo o aspect ratio | worker via `PutObject` com `ContentType: image/jpeg` (per `phase-03-videos/TD-11`) |

**Upload constants** (per `phase-03-videos/TD-07` Note): tamanho máximo `10 * 1024^3` = 10737418240 bytes; `part_size` fixo de 67108864 bytes (64 MiB), última parte menor; `part_count = ceil(declared_size / part_size)` (≤ 160).

### API Contracts

Todos os endpoints abaixo exigem `Authorization: Bearer <access_token>` (guard global `JwtAuthGuard`, `phase-02-auth/TD-02`) e são servidos por `VideosController` (`@ApiTags('videos')`, `@ApiBearerAuth('access-token')`, `@SkipThrottle()` — o rate limit de `phase-02-auth/TD-08` é escopado ao fluxo de auth e não pode bloquear o envio de lotes de partes). Erros seguem o envelope `{ statusCode, error, message }` (`phase-02-auth/TD-07`) e são documentados com `@ApiResponse({ schema: { $ref: getSchemaPath(ApiErrorEnvelope) } })` (`openapi-docs-nestjs/TD-01`). Um `:id` que não é UUID retorna `400 VALIDATION_ERROR` (`ParseUUIDPipe`). Um vídeo inexistente ou de outro canal retorna `404 VIDEO_NOT_FOUND` em **todos** os endpoints com `:id` (existência não vaza — per `phase-03-videos/TD-15`).

**`VideoResponseDto`** — representação do vídeo para o dono (per `phase-03-videos/TD-15`, Note AMB-6), reutilizada pelos endpoints abaixo:

- id: string (uuid)
- slug: string — 11 caracteres; a URL única do vídeo é construída a partir dele (per `phase-03-videos/TD-14`)
- title: string
- original_filename: string
- mime_type: string — `video/mp4` | `video/webm`
- status: string — `draft` | `processing` | `ready` | `failed`
- failure_reason: string | null — ver Data Model → Failure reasons
- duration: number | null — segundos
- width: integer | null
- height: integer | null
- size: integer | null — bytes
- metadata: object | null — `{ video_codec, audio_codec, format_name, bit_rate, frame_rate }`
- has_thumbnail: boolean
- created_at: string (ISO-8601)
- updated_at: string (ISO-8601)

---

#### POST /videos (SI-03.8)

Inicia o upload: valida formato e tamanho declarados, cria o multipart upload em `videos/{videoId}/original` e pré-cadastra o vídeo como `draft` (per `phase-03-videos/TD-07`, `phase-03-videos/TD-09`, `phase-03-videos/TD-10`).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <access_token>

**Request body:**
- file_name: string, required — 1..255 caracteres; a extensão (`.mp4` / `.webm`, case-insensitive) deve corresponder a `mime_type`
- mime_type: string, required — `video/mp4` | `video/webm`
- size: integer, required — ≥ 1 e ≤ 10737418240 (bytes)
- title: string, optional — 1..100 caracteres após trim; default = `file_name` sem extensão (truncado em 100)

**Response 201:** `VideoResponseDto` (com `status: "draft"` e campos de processamento `null`) acrescido de:
- upload: object
  - part_size: integer — `67108864`
  - part_count: integer — `ceil(size / part_size)`

**Error responses:**
- 400 VALIDATION_ERROR: corpo inválido (campo ausente, tipo errado, `size < 1`, propriedade desconhecida)
- 400 UNSUPPORTED_VIDEO_FORMAT: `mime_type` fora da allowlist ou extensão de `file_name` incompatível com `mime_type`
- 400 VIDEO_TOO_LARGE: `size` > 10737418240
- 401 Unauthorized: sem token / token inválido
- 404 CHANNEL_NOT_FOUND: o usuário autenticado não possui canal

---

#### GET /videos/:id (SI-03.9)

Leitura do vídeo pelo dono em qualquer status — permite acompanhar o processamento e obter o `slug` (per `phase-03-videos/TD-15`, Note AMB-6).

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:** `VideoResponseDto`

**Error responses:**
- 400 VALIDATION_ERROR: `:id` não é UUID
- 401 Unauthorized: sem token / token inválido
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal

---

#### GET /videos/:id/upload (SI-03.10)

Estado do upload para retomada: partes já armazenadas, obtidas via `ListParts` (per `phase-03-videos/TD-07`).

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- part_size: integer — `67108864`
- part_count: integer
- uploaded_parts: array of `{ part_number: integer, size: integer }` — ordenado por `part_number`

**Error responses:**
- 400 VALIDATION_ERROR: `:id` não é UUID
- 401 Unauthorized: sem token / token inválido
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal
- 409 INVALID_VIDEO_STATUS: vídeo não está em `draft`

---

#### POST /videos/:id/upload/part-urls (SI-03.11)

Gera URLs pré-assinadas de `UploadPart` (assinadas com o cliente **público**, `S3_PUBLIC_ENDPOINT` — per `phase-03-videos/TD-05`) para um lote de partes; o browser faz `PUT` de cada parte direto no storage (per `phase-03-videos/TD-07`). TTL = `S3_UPLOAD_PART_URL_TTL_SECONDS` (default 3600).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <access_token>

**Request body:**
- part_numbers: integer[], required — 1..100 itens, únicos, cada um ≥ 1 e ≤ `part_count`

**Response 200:**
- expires_in: integer — segundos de validade das URLs
- parts: array of `{ part_number: integer, url: string }` — na mesma ordem de `part_numbers`

**Error responses:**
- 400 VALIDATION_ERROR: corpo inválido (array vazio, > 100 itens, duplicados, não inteiros, < 1) ou `:id` não é UUID
- 400 INVALID_PART_NUMBER: algum `part_number` > `part_count`
- 401 Unauthorized: sem token / token inválido
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal
- 409 INVALID_VIDEO_STATUS: vídeo não está em `draft`

---

#### POST /videos/:id/upload/complete (SI-03.12)

Conclui o upload: verifica as partes via `ListParts`, executa `CompleteMultipartUpload` com os ETags do `ListParts`, valida o tamanho real com `HeadObject`, faz a transição `draft → processing` e enfileira o job de processamento (per `phase-03-videos/TD-07`, `phase-03-videos/TD-08`). Idempotente: chamado de novo com o vídeo em `processing` ou `ready`, devolve `200` com o estado atual sem efeitos colaterais.

**Request headers:**
- Authorization: Bearer <access_token>

**Request body:** nenhum.

**Response 200:** `VideoResponseDto` (com `status: "processing"`, ou o status atual em uma repetição idempotente)

**Error responses:**
- 400 VALIDATION_ERROR: `:id` não é UUID
- 401 Unauthorized: sem token / token inválido
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal
- 409 UPLOAD_INCOMPLETE: faltam partes (`1..part_count` não contíguo) ou a soma dos tamanhos das partes ≠ `declared_size`; o vídeo continua em `draft` e o upload pode ser retomado
- 409 UPLOAD_SIZE_MISMATCH: o objeto montado tem tamanho ≠ `declared_size` (ou > 10 GiB); o objeto é removido e o vídeo vai para `failed` com `size_mismatch`
- 409 INVALID_VIDEO_STATUS: vídeo em `failed` (inclusive abandonado pelo sweep durante a conclusão)

---

#### GET /videos/:id/stream (SI-03.13)

Reprodução via streaming: redireciona para uma URL pré-assinada `GetObject` de `videos/{videoId}/original`, assinada com o cliente público; o storage atende `Range`/`206` nativamente (per `phase-03-videos/TD-15`). TTL = `S3_DELIVERY_URL_TTL_SECONDS` (default 14400).

**Request headers:**
- Authorization: Bearer <access_token>

**Response 302:**
- Location: string — URL pré-assinada
- Cache-Control: `private, no-store`

**Error responses:**
- 400 VALIDATION_ERROR: `:id` não é UUID
- 401 Unauthorized: sem token / token inválido
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal
- 409 VIDEO_NOT_READY: vídeo não está em `ready`

---

#### GET /videos/:id/download (SI-03.13)

Download do vídeo: igual ao stream, mas a URL pré-assinada carrega `ResponseContentDisposition` = `attachment; filename="<original_filename ASCII-safe>"; filename*=UTF-8''<original_filename percent-encoded>` (per `phase-03-videos/TD-15`).

**Request headers:**
- Authorization: Bearer <access_token>

**Response 302:**
- Location: string — URL pré-assinada com `response-content-disposition`
- Cache-Control: `private, no-store`

**Error responses:**
- 400 VALIDATION_ERROR: `:id` não é UUID
- 401 Unauthorized: sem token / token inválido
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal
- 409 VIDEO_NOT_READY: vídeo não está em `ready`

---

#### GET /videos/:id/thumbnail (SI-03.13)

Thumbnail: redireciona para a URL pré-assinada `GetObject` de `videos/{videoId}/thumbnail.jpg` (per `phase-03-videos/TD-15`, `phase-03-videos/TD-11`). TTL = `S3_DELIVERY_URL_TTL_SECONDS`.

**Request headers:**
- Authorization: Bearer <access_token>

**Response 302:**
- Location: string — URL pré-assinada
- Cache-Control: `private, no-store`

**Error responses:**
- 400 VALIDATION_ERROR: `:id` não é UUID
- 401 Unauthorized: sem token / token inválido
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal
- 409 VIDEO_NOT_READY: vídeo não está em `ready` (ou `has_thumbnail = false`)

---

#### Validation Rules — Videos

| Field | Rule | Enforced by |
|-------|------|-------------|
| `file_name` | string, 1..255, extensão `.mp4`/`.webm` compatível com `mime_type` | DTO (`@IsString`, `@Length`) + `VideoUploadsService` (`UNSUPPORTED_VIDEO_FORMAT`) |
| `mime_type` | string; allowlist `video/mp4`, `video/webm` | DTO (`@IsString`) + `VideoUploadsService` (`UNSUPPORTED_VIDEO_FORMAT`) |
| `size` | inteiro ≥ 1; ≤ 10737418240 | DTO (`@IsInt`, `@Min(1)`) + `VideoUploadsService` (`VIDEO_TOO_LARGE`) |
| `title` | opcional; string 1..100 após trim | DTO (`@IsOptional`, `@IsString`, `@Length(1, 100)`, `@Transform` trim) |
| `part_numbers` | array 1..100, únicos, inteiros ≥ 1; cada um ≤ `part_count` | DTO (`@IsArray`, `@ArrayMinSize(1)`, `@ArrayMaxSize(100)`, `@ArrayUnique`, `@IsInt({ each: true })`, `@Min(1, { each: true })`) + `VideoUploadsService` (`INVALID_PART_NUMBER`) |
| `:id` | UUID | `ParseUUIDPipe` |

### Authorization Matrix

"Owner" = usuário autenticado cujo canal (`channels.user_id = sub`) é o `channel_id` do vídeo (per `phase-03-videos/TD-10`, Note AMB-2). Em Phase 03 todo vídeo é um rascunho não publicado, então não há acesso anônimo nem regras de visibilidade (per `phase-03-videos/TD-15`, Note AMB-4 — adiado para Fase 04/05).

| Endpoint | Anonymous | Authenticated (não dono) | Owner | Restrição de status |
|----------|-----------|--------------------------|-------|---------------------|
| POST /videos | ✗ 401 | ✓ (cria o vídeo no próprio canal e passa a ser o dono) | — | — |
| GET /videos/:id | ✗ 401 | ✗ 404 VIDEO_NOT_FOUND | ✓ | qualquer status |
| GET /videos/:id/upload | ✗ 401 | ✗ 404 VIDEO_NOT_FOUND | ✓ | `draft` (senão 409 INVALID_VIDEO_STATUS) |
| POST /videos/:id/upload/part-urls | ✗ 401 | ✗ 404 VIDEO_NOT_FOUND | ✓ | `draft` (senão 409 INVALID_VIDEO_STATUS) |
| POST /videos/:id/upload/complete | ✗ 401 | ✗ 404 VIDEO_NOT_FOUND | ✓ | `draft`; `processing`/`ready` = replay idempotente 200; `failed` = 409 INVALID_VIDEO_STATUS |
| GET /videos/:id/stream | ✗ 401 | ✗ 404 VIDEO_NOT_FOUND | ✓ | `ready` (senão 409 VIDEO_NOT_READY) |
| GET /videos/:id/download | ✗ 401 | ✗ 404 VIDEO_NOT_FOUND | ✓ | `ready` (senão 409 VIDEO_NOT_READY) |
| GET /videos/:id/thumbnail | ✗ 401 | ✗ 404 VIDEO_NOT_FOUND | ✓ | `ready` (senão 409 VIDEO_NOT_READY) |

A checagem de dono acontece **antes** da checagem de status: um não dono recebe sempre `404`, nunca `409`, para não vazar a existência nem o estado do vídeo. As URLs pré-assinadas devolvidas são credenciais portáveis até expirarem (TTL configurável); por isso os redirects levam `Cache-Control: private, no-store`.

### Error Catalog

**Error response format:** herdado de Phase 02 (`phase-02-auth/TD-07`) — `{ statusCode: number, error: string, message: string }`. Novas classes ficam em `src/videos/exceptions/video.exceptions.ts`, estendendo `DomainException` de `src/common/exceptions/domain.exception.ts`, e são mapeadas pelo `DomainExceptionFilter` global já existente.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| UNSUPPORTED_VIDEO_FORMAT | 400 | Only MP4 and WebM videos are supported | `POST /videos` com `mime_type` fora da allowlist ou extensão de `file_name` incompatível com o `mime_type` (per `phase-03-videos/TD-09`) |
| VIDEO_TOO_LARGE | 400 | Video exceeds the 10 GiB size limit | `POST /videos` com `size` > 10737418240 (per `phase-03-videos/TD-07`) |
| INVALID_PART_NUMBER | 400 | Part number is out of range for this upload | `POST /videos/:id/upload/part-urls` com algum `part_number` > `part_count` |
| CHANNEL_NOT_FOUND | 404 | Channel not found for the authenticated user | `POST /videos` quando o usuário do token não tem canal |
| VIDEO_NOT_FOUND | 404 | Video not found | qualquer endpoint com `:id` quando o vídeo não existe ou pertence a outro canal (per `phase-03-videos/TD-15`) |
| INVALID_VIDEO_STATUS | 409 | Video is not in a valid status for this operation | operações de upload (`GET /videos/:id/upload`, `POST .../part-urls`, `POST .../complete`) com o vídeo fora de `draft` (exceto o replay idempotente de `complete` em `processing`/`ready`), ou transição condicional perdida para o sweep |
| UPLOAD_INCOMPLETE | 409 | Upload is missing parts | `POST /videos/:id/upload/complete` com partes faltando ou soma de tamanhos ≠ `declared_size`; também quando o multipart não existe mais e o objeto final não está no storage (per `phase-03-videos/TD-08`) |
| UPLOAD_SIZE_MISMATCH | 409 | Uploaded file size does not match the declared size | `POST /videos/:id/upload/complete` quando `HeadObject.ContentLength` ≠ `declared_size` ou > 10 GiB; o vídeo vai para `failed` (`size_mismatch`) (per `phase-03-videos/TD-07`) |
| VIDEO_NOT_READY | 409 | Video is not ready | `GET /videos/:id/stream`, `/download` ou `/thumbnail` com `status ≠ ready` (per `phase-03-videos/TD-15`, Note AMB-4) |

Erros fora do catálogo de domínio, já existentes: `400 VALIDATION_ERROR` (`ValidationExceptionFilter`, DTO e `ParseUUIDPipe`) e `401 Unauthorized` (`JwtAuthGuard`). Falhas de storage (`S3ServiceException`) não mapeadas acima propagam como `500` e são logadas.

### Events/Messages

Broker: Redis (`redis:8.10.2-alpine`, `--maxmemory-policy noeviction`) via BullMQ 6 + `@nestjs/bullmq` (per `phase-03-videos/TD-01`). Conexão: `{ host: REDIS_HOST, port: REDIS_PORT }` e `prefix: QUEUE_PREFIX` (default `streamtube`; a suíte de testes usa `streamtube-test`, isolando-a do `video-worker` de dev). Contratos (nomes de fila, nomes de job, tipos de payload, opções padrão) ficam em `src/video-processing/video-processing.queue.ts`. Consumers (`@Processor`) são registrados **somente** no grafo de módulos do worker (per `phase-03-videos/TD-02`); a API só produz.

#### Job `process-video` — fila `video-processing`

**Payload:**

```json
{ "videoId": "uuid" }
```

**Job options:**

```json
{
  "jobId": "<videoId>",
  "attempts": 5,
  "backoff": { "type": "exponential", "delay": 5000 },
  "removeOnComplete": true,
  "removeOnFail": true
}
```

**Producer:** `VideoProcessingProducer.enqueue(videoId)` — chamado por `VideoUploadsService.complete` (API, após `draft → processing`) e por `VideoReconciliationService` (worker, re-enqueue de `processing` travado) (per `phase-03-videos/TD-08`, `phase-03-videos/TD-13`)
**Consumer:** `VideoProcessingConsumer` (`@Processor('video-processing', { concurrency: 1 })`, estende `WorkerHost`) → `VideoProcessingService.process(videoId)` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-11`, `phase-03-videos/TD-12`)
**Trigger:** conclusão bem-sucedida do upload (`POST /videos/:id/upload/complete`) ou sweep encontrando vídeo em `processing` há mais de 1 hora.
**Delivery semantics:** at-least-once (per `phase-03-videos/TD-13`). Idempotência: `jobId = videoId` descarta `add` duplicado enquanto o job existir no Redis; `removeOnComplete`/`removeOnFail` liberam o `jobId` para re-enqueue; o consumer não faz nada quando o vídeo não existe ou não está mais em `processing`; a transição `processing → ready` é condicional.
**Failure handling:** erro permanente (`unsupported_format`, `invalid_media`) → `throw new UnrecoverableError(<reason>)` (falha imediata, sem retry); erro transitório (rede/storage/timeout do ffmpeg) → `throw` comum, retry com backoff exponencial. `@OnWorkerEvent('failed')` marca `failed` quando o erro é `UnrecoverableError`, quando `job.attemptsMade >= job.opts.attempts`, ou quando o job excedeu `maxStalledCount` ("stalled more than allowable limit" → `processing_error`).

#### Job scheduler `reconcile-videos` — fila `video-reconciliation`

**Payload:**

```json
{}
```

**Scheduler:** `queue.upsertJobScheduler('reconcile-videos', { every: 900000 }, { name: 'reconcile', data: {}, opts: { removeOnComplete: true, removeOnFail: 100 } })` — id estável, idempotente a cada boot do worker (per `phase-03-videos/TD-13`)
**Producer:** `VideoReconciliationScheduler` (`onApplicationBootstrap` do worker)
**Consumer:** `VideoReconciliationConsumer` (`@Processor('video-reconciliation', { concurrency: 1 })`) → `VideoReconciliationService.run(now)`
**Trigger:** a cada 15 minutos (fila separada de `video-processing` para não esperar atrás de jobs FFmpeg longos).
**Delivery semantics:** at-least-once; cada execução é idempotente. Cada run processa até 100 vídeos por caso:
- **Abandoned drafts:** `status = draft` e `created_at < now − 24h` → `AbortMultipartUpload` (`NoSuchUpload` = já abortado) → `UPDATE ... SET status = 'failed', failure_reason = 'upload_abandoned' WHERE id = :id AND status = 'draft'`. A linha é mantida.
- **Stuck processing:** `status = processing` e `processing_started_at < now − 1h` → `VideoProcessingProducer.enqueue(videoId)` (o `jobId` deduplica job ainda enfileirado/rodando).

#### Domain transitions observáveis pelo cliente (Cross-layer, via polling)

Não há push para o frontend nesta fase: o cliente acompanha `status`/`failure_reason` via `GET /videos/:id` (per `phase-03-videos/TD-15`, Note AMB-6).

---

## Dependency Map

```
SI-03.1 (root — deps, FFmpeg, minio/minio-init/redis)
└── SI-03.2 — depends on SI-03.1 (env vars e serviços existem)
    ├── SI-03.3 — depends on SI-03.2 (namespaces entram nas opções compartilhadas)
    ├── SI-03.4 — depends on SI-03.1 + SI-03.2 (MinIO + namespace storage)
    │   └── SI-03.14 — depends on SI-03.1 + SI-03.4 (FFmpeg + URL pré-assinada interna)
    └── SI-03.5 — depends on SI-03.1 + SI-03.2 (Redis + namespace queue)

SI-03.6 (root — entidade + migration)
└── SI-03.7 — depends on SI-03.3 + SI-03.6 (DatabaseModule + entidade)
    ├── SI-03.8 — depends on SI-03.4 + SI-03.7 (POST /videos)
    │   ├── SI-03.9 — depends on SI-03.8 (GET /videos/:id)
    │   │   └── SI-03.13 — depends on SI-03.9 (stream/download/thumbnail)
    │   ├── SI-03.10 — depends on SI-03.8 (GET /videos/:id/upload)
    │   └── SI-03.11 — depends on SI-03.8 (part-urls)
    │       └── SI-03.12 — depends on SI-03.5 + SI-03.11 (complete + enqueue)
    └── SI-03.15 — depends on SI-03.7 + SI-03.14 (metadados + thumbnail)
        └── SI-03.16 — depends on SI-03.3 + SI-03.5 + SI-03.15 (worker runtime + video-worker)
            └── SI-03.17 — depends on SI-03.16 (sweep de reconciliação)

SI-03.12 + SI-03.13 + SI-03.16
└── SI-03.18 — E2E do pipeline completo

SI-03.12 + SI-03.13
└── SI-03.19 — OpenAPI + openapi.json

SI-03.18 + SI-03.19
└── SI-03.20 — CLAUDE.md + guia de testes
```

Ordem linearizada sugerida: SI-03.1 → SI-03.2 → SI-03.3, SI-03.4, SI-03.5, SI-03.6 (paralelos) → SI-03.7 → SI-03.8, SI-03.14 (paralelos) → SI-03.9, SI-03.10, SI-03.11, SI-03.15 (paralelos) → SI-03.12, SI-03.13, SI-03.16 (paralelos) → SI-03.17, SI-03.19 → SI-03.18 → SI-03.20

---

## Deliverables

- [x] SI-03.1 — Infra: dependências, FFmpeg na imagem e serviços Compose (minio, minio-init, redis)
- [x] SI-03.2 — Namespaces de configuração `storage` e `queue` e ambiente de teste isolado
- [x] SI-03.3 — DatabaseModule e opções de ConfigModule compartilhadas entre API e worker
- [x] SI-03.4 — StorageModule: clientes S3 interno/público, multipart e URLs pré-assinadas
- [x] SI-03.5 — QueueModule e fila `video-processing` (contratos + producer)
- [x] SI-03.6 — Entidade `Video` e migration `CreateVideos`
- [x] SI-03.7 — VideosService: pré-cadastro com slug único, leitura do dono e transições condicionais
- [x] SI-03.8 — Endpoint POST /videos (início do upload + pré-cadastro do rascunho)
- [x] SI-03.9 — Endpoint GET /videos/:id (leitura do dono)
- [x] SI-03.10 — Endpoint GET /videos/:id/upload (estado para retomada)
- [x] SI-03.11 — Endpoint POST /videos/:id/upload/part-urls (URLs pré-assinadas de partes)
- [x] SI-03.12 — Endpoint POST /videos/:id/upload/complete (conclusão + disparo do processamento)
- [x] SI-03.13 — Endpoints de entrega: streaming, download e thumbnail
- [x] SI-03.14 — MediaToolsService: wrapper tipado de ffprobe/ffmpeg
- [x] SI-03.15 — VideoProcessingService: extração de metadados e geração de thumbnail
- [x] SI-03.16 — Runtime do worker: consumer BullMQ, entrypoint separado e serviço Compose `video-worker`
- [x] SI-03.17 — Sweep de reconciliação: job scheduler `reconcile-videos`
- [x] SI-03.18 — E2E do pipeline completo: upload → processamento → streaming/download
- [x] SI-03.19 — OpenAPI: completar schemas de vídeos e regenerar `openapi.json`
- [x] SI-03.20 — Documentação: seção de vídeos nos CLAUDE.md e estratégia de testes de storage/fila

**Full test suites:**

- [x] `docker compose up -d` sobe `db`, `mailpit`, `minio`, `minio-init` (exit 0), `redis`, `nestjs-api` e `video-worker` juntos
- [x] Backend tests pass — unit + integration (`docker compose exec nestjs-api npm test -- --runInBand`)
- [x] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [x] Type/compilation checks pass (`docker compose exec nestjs-api npx tsc --noEmit`)
- [x] Lint passes (`docker compose exec nestjs-api npm run lint`)
- [x] Project builds successfully, including `dist/worker.js` (`docker compose exec nestjs-api npm run build`)
