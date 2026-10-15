import { randomBytes } from 'crypto';
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

const MIB = 1024 * 1024;

async function createApp(): Promise<INestApplication<App>> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication<INestApplication<App>>();
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
  return app;
}

describe('videos-upload-part-urls', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storage: StorageService;
  let owner: AuthenticatedUser;
  let stranger: AuthenticatedUser;
  let videoId: string;
  const createdVideos = new Map<string, string>();

  const createVideo = async (
    target: INestApplication<App>,
    token: string,
  ): Promise<string> => {
    const res = await request(target.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({ file_name: 'clip.mp4', mime_type: 'video/mp4', size: 134217729 })
      .expect(201);
    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: res.body.id });
    createdVideos.set(row.id, row.upload_id);
    return row.id;
  };

  const postPartUrls = (
    body: object,
    token: string,
    target: INestApplication<App> = app,
    id: string = videoId,
  ) =>
    request(target.getHttpServer())
      .post(`/videos/${id}/upload/part-urls`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const clearThrottler = (target: INestApplication<App>): void => {
    target.get<ThrottlerStorageService>(ThrottlerStorage).storage.clear();
  };

  beforeAll(async () => {
    app = await createApp();
    dataSource = app.get(DataSource);
    storage = app.get(StorageService);
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
    clearThrottler(app);
    owner = await createAuthenticatedUser(app);
    stranger = await createAuthenticatedUser(app);
    videoId = await createVideo(app, owner.access_token);
  });

  // 1. Gerar URLs pré-assinadas de partes

  test('devolve-urls-publicas-na-ordem-pedida', async () => {
    const res = await postPartUrls(
      { part_numbers: [1, 2] },
      owner.access_token,
    ).expect(200);

    expect(res.body.expires_in).toBe(3600);
    expect(
      res.body.parts.map((p: { part_number: number }) => p.part_number),
    ).toEqual([1, 2]);
    for (const part of res.body.parts as { url: string }[]) {
      expect(part.url.startsWith(process.env.S3_PUBLIC_ENDPOINT!)).toBe(true);
      const query = new URL(part.url).searchParams;
      expect(query.get('partNumber')).toEqual(expect.any(String));
      expect(query.get('uploadId')).toBe(createdVideos.get(videoId));
    }

    const reordered = await postPartUrls(
      { part_numbers: [3, 1] },
      owner.access_token,
    ).expect(200);
    expect(
      reordered.body.parts.map((p: { part_number: number }) => p.part_number),
    ).toEqual([3, 1]);
  });

  test('put-na-url-e-aceito-pelo-storage', async () => {
    const res = await postPartUrls(
      { part_numbers: [1] },
      owner.access_token,
    ).expect(200);

    const put = await fetch(res.body.parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(randomBytes(5 * MIB)),
    });

    expect(put.status).toBe(200);
    expect(put.headers.get('etag')).toBeTruthy();
    const status = await request(app.getHttpServer())
      .get(`/videos/${videoId}/upload`)
      .set('Authorization', `Bearer ${owner.access_token}`)
      .expect(200);
    expect(status.body.uploaded_parts).toEqual([
      { part_number: 1, size: 5 * MIB },
    ]);
  });

  describe('with S3_UPLOAD_PART_URL_TTL_SECONDS=600', () => {
    const originalTtl = process.env.S3_UPLOAD_PART_URL_TTL_SECONDS;
    let shortTtlApp: INestApplication<App>;

    beforeAll(async () => {
      process.env.S3_UPLOAD_PART_URL_TTL_SECONDS = '600';
      shortTtlApp = await createApp();
    });

    afterAll(async () => {
      await shortTtlApp.close();
      if (originalTtl === undefined) {
        delete process.env.S3_UPLOAD_PART_URL_TTL_SECONDS;
      } else {
        process.env.S3_UPLOAD_PART_URL_TTL_SECONDS = originalTtl;
      }
    });

    test('ttl-configurado-reflete-em-expires-in', async () => {
      clearThrottler(shortTtlApp);
      const user = await createAuthenticatedUser(shortTtlApp);
      const id = await createVideo(shortTtlApp, user.access_token);

      const res = await postPartUrls(
        { part_numbers: [1] },
        user.access_token,
        shortTtlApp,
        id,
      ).expect(200);

      expect(res.body.expires_in).toBe(600);
      expect(res.body.parts[0].url).toContain('X-Amz-Expires=600');
    });
  });

  // 2. Rejeitar lotes inválidos, status incorreto e não donos

  test('numero-acima-de-part-count-retorna-invalid-part-number', async () => {
    const res = await postPartUrls(
      { part_numbers: [1, 4] },
      owner.access_token,
    ).expect(400);

    expect(res.body.error).toBe('INVALID_PART_NUMBER');
  });

  test('lote-malformado-retorna-validation-error', async () => {
    const tooMany = Array.from({ length: 101 }, (_, i) => i + 1);

    for (const partNumbers of [[], tooMany, [1, 1], [0]]) {
      const res = await postPartUrls(
        { part_numbers: partNumbers },
        owner.access_token,
      ).expect(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    }
  });

  test('fora-de-draft-409-e-nao-dono-404', async () => {
    const strangerRes = await postPartUrls(
      { part_numbers: [1] },
      stranger.access_token,
    ).expect(404);
    expect(strangerRes.body.error).toBe('VIDEO_NOT_FOUND');

    const result = await dataSource.getRepository(Video).update(
      { id: videoId },
      {
        status: VideoStatus.Processing,
        processing_started_at: () => 'now()',
      },
    );
    expect(result.affected).toBe(1);

    const ownerRes = await postPartUrls(
      { part_numbers: [1] },
      owner.access_token,
    ).expect(409);
    expect(ownerRes.body.error).toBe('INVALID_VIDEO_STATUS');
  });
});
