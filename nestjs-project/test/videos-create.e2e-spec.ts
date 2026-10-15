import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video } from '../src/videos/entities/video.entity';
import {
  videoOriginalKey,
  videoPrefix,
} from '../src/videos/video-storage-keys';
import {
  type AuthenticatedUser,
  createAuthenticatedUser,
} from './helpers/auth.helper';

describe('videos-create', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let owner: AuthenticatedUser;
  const createdVideos = new Map<string, string>();

  const validBody = {
    file_name: 'clip.mp4',
    mime_type: 'video/mp4',
    size: 1048576,
  };

  const postVideo = (
    body: object,
    token: string | null = owner.access_token,
  ) => {
    const req = request(app.getHttpServer()).post('/videos');
    if (token) {
      void req.set('Authorization', `Bearer ${token}`);
    }
    return req.send(body);
  };

  const trackCreated = async (id: string): Promise<void> => {
    const video = await dataSource.getRepository(Video).findOneBy({ id });
    if (video) {
      createdVideos.set(id, video.upload_id);
    }
  };

  const countVideos = (): Promise<number> =>
    dataSource.getRepository(Video).count();

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    storage = moduleFixture.get(StorageService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    for (const [id, uploadId] of createdVideos) {
      await storage.abortMultipartUpload(videoOriginalKey(id), uploadId);
      await storage.deletePrefix(videoPrefix(id));
    }
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    // createAuthenticatedUser makes 3 auth requests against a 10/min limit
    throttlerStorage.storage.clear();
    owner = await createAuthenticatedUser(app);
  });

  // 1. Iniciar upload e pré-cadastrar o rascunho

  test('cria-rascunho-com-plano-de-uma-parte', async () => {
    const res = await postVideo(validBody).expect(201);
    await trackCreated(res.body.id);

    expect(res.body).toMatchObject({
      id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      ),
      status: 'draft',
      slug: expect.stringMatching(/^[A-Za-z0-9_-]{11}$/),
      title: 'clip',
      original_filename: 'clip.mp4',
      mime_type: 'video/mp4',
      failure_reason: null,
      duration: null,
      width: null,
      height: null,
      size: null,
      metadata: null,
      has_thumbnail: false,
      upload: { part_size: 67108864, part_count: 1 },
    });

    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: res.body.id });
    const channel = await dataSource
      .getRepository(Channel)
      .findOneByOrFail({ user_id: owner.userId });
    expect(row.status).toBe('draft');
    expect(row.upload_id).toEqual(expect.any(String));
    expect(row.upload_id.length).toBeGreaterThan(0);
    expect(row.channel_id).toBe(channel.id);
  });

  test('tamanho-maximo-gera-160-partes', async () => {
    const res = await postVideo({
      file_name: 'big.mp4',
      mime_type: 'video/mp4',
      size: 10737418240,
    }).expect(201);
    await trackCreated(res.body.id);

    expect(res.body.upload).toEqual({
      part_size: 67108864,
      part_count: 160,
    });
  });

  test('requisicoes-seguidas-nao-sao-limitadas', async () => {
    const slugs: string[] = [];

    for (let i = 0; i < 15; i++) {
      const res = await postVideo(validBody);
      expect(res.status).toBe(201);
      await trackCreated(res.body.id);
      slugs.push(res.body.slug);
    }

    expect(new Set(slugs).size).toBe(15);
  });

  // 2. Rejeitar entradas inválidas e acesso anônimo

  test('tamanho-acima-do-limite-retorna-video-too-large', async () => {
    const res = await postVideo({
      file_name: 'big.mp4',
      mime_type: 'video/mp4',
      size: 10737418241,
    }).expect(400);

    expect(res.body).toEqual({
      statusCode: 400,
      error: 'VIDEO_TOO_LARGE',
      message: expect.any(String),
    });
    await expect(countVideos()).resolves.toBe(0);
  });

  test('formato-nao-suportado-retorna-unsupported-video-format', async () => {
    const quicktime = await postVideo({
      file_name: 'clip.mov',
      mime_type: 'video/quicktime',
      size: 1048576,
    }).expect(400);
    expect(quicktime.body.error).toBe('UNSUPPORTED_VIDEO_FORMAT');

    const mismatch = await postVideo({
      file_name: 'clip.webm',
      mime_type: 'video/mp4',
      size: 1048576,
    }).expect(400);
    expect(mismatch.body.error).toBe('UNSUPPORTED_VIDEO_FORMAT');
    await expect(countVideos()).resolves.toBe(0);
  });

  test('corpo-invalido-retorna-validation-error', async () => {
    const missingSize = await postVideo({
      file_name: 'clip.mp4',
      mime_type: 'video/mp4',
    }).expect(400);
    expect(missingSize.body.error).toBe('VALIDATION_ERROR');

    const unknownProperty = await postVideo({
      ...validBody,
      foo: 'bar',
    }).expect(400);
    expect(unknownProperty.body.error).toBe('VALIDATION_ERROR');
  });

  test('sem-token-retorna-401', async () => {
    await postVideo(validBody, null).expect(401);

    await expect(countVideos()).resolves.toBe(0);
  });
});
