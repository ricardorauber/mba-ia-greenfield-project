import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import {
  videoOriginalKey,
  videoPrefix,
} from '../src/videos/video-storage-keys';
import {
  type AuthenticatedUser,
  createAuthenticatedUser,
} from './helpers/auth.helper';

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

describe('videos-get', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let owner: AuthenticatedUser;
  let stranger: AuthenticatedUser;
  let video: { id: string; slug: string };
  const createdVideos = new Map<string, string>();

  const getVideo = (id: string, token: string | null) => {
    const req = request(app.getHttpServer()).get(`/videos/${id}`);
    if (token) {
      void req.set('Authorization', `Bearer ${token}`);
    }
    return req;
  };

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
    // Two users = 6 auth requests against a 10/min limit
    throttlerStorage.storage.clear();
    owner = await createAuthenticatedUser(app);
    stranger = await createAuthenticatedUser(app);

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${owner.access_token}`)
      .send({ file_name: 'clip.mp4', mime_type: 'video/mp4', size: 1048576 })
      .expect(201);
    video = { id: res.body.id, slug: res.body.slug };
    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });
    createdVideos.set(video.id, row.upload_id);
  });

  // 1. Ler o vídeo como dono

  test('dono-le-rascunho-recem-criado', async () => {
    const res = await getVideo(video.id, owner.access_token).expect(200);

    expect(res.body).toMatchObject({
      id: video.id,
      slug: video.slug,
      status: 'draft',
      failure_reason: null,
      duration: null,
      width: null,
      height: null,
      size: null,
      metadata: null,
      has_thumbnail: false,
    });
    expect(res.body.created_at).toMatch(ISO_8601);
    expect(res.body.updated_at).toMatch(ISO_8601);
  });

  test('dono-le-video-failed-com-motivo', async () => {
    const result = await dataSource
      .getRepository(Video)
      .update(
        { id: video.id },
        { status: VideoStatus.Failed, failure_reason: 'unsupported_format' },
      );
    expect(result.affected).toBe(1);

    const res = await getVideo(video.id, owner.access_token).expect(200);

    expect(res.body).toMatchObject({
      status: 'failed',
      failure_reason: 'unsupported_format',
    });
  });

  // 2. Negar leitura a não donos, ids inválidos e anônimos

  test('nao-dono-recebe-404-identico-ao-inexistente', async () => {
    const othersVideo = await getVideo(video.id, stranger.access_token).expect(
      404,
    );
    expect(othersVideo.body.error).toBe('VIDEO_NOT_FOUND');

    const missing = await getVideo(randomUUID(), stranger.access_token).expect(
      404,
    );
    expect(missing.body.error).toBe('VIDEO_NOT_FOUND');
    expect(othersVideo.body).toEqual(missing.body);
  });

  test('id-nao-uuid-retorna-validation-error', async () => {
    const res = await getVideo('abc', owner.access_token).expect(400);

    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  test('sem-token-retorna-401', async () => {
    await getVideo(video.id, null).expect(401);
  });
});
