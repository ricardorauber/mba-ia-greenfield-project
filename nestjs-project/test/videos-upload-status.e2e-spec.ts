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

describe('videos-upload-status', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let owner: AuthenticatedUser;
  let stranger: AuthenticatedUser;
  let video: { id: string; uploadId: string };
  const createdVideos = new Map<string, string>();

  const getUploadStatus = (token: string) =>
    request(app.getHttpServer())
      .get(`/videos/${video.id}/upload`)
      .set('Authorization', `Bearer ${token}`);

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
      .send({ file_name: 'clip.mp4', mime_type: 'video/mp4', size: 134217729 })
      .expect(201);
    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: res.body.id });
    video = { id: row.id, uploadId: row.upload_id };
    createdVideos.set(row.id, row.upload_id);
  });

  // 1. Consultar o estado do upload para retomada

  test('rascunho-recem-criado-sem-partes', async () => {
    const res = await getUploadStatus(owner.access_token).expect(200);

    expect(res.body).toEqual({
      part_size: 67108864,
      part_count: 3,
      uploaded_parts: [],
    });
  });

  test('lista-partes-ja-enviadas', async () => {
    const partUrls = await request(app.getHttpServer())
      .post(`/videos/${video.id}/upload/part-urls`)
      .set('Authorization', `Bearer ${owner.access_token}`)
      .send({ part_numbers: [1, 3] })
      .expect(200);
    const urls = partUrls.body.parts as { url: string }[];
    expect(urls).toHaveLength(2);

    for (const [{ url }, size] of [
      [urls[0], 5 * MIB],
      [urls[1], MIB],
    ] as const) {
      const put = await fetch(url, {
        method: 'PUT',
        body: new Uint8Array(randomBytes(size)),
      });
      expect(put.status).toBe(200);
      expect(put.headers.get('etag')).toBeTruthy();
    }

    const res = await getUploadStatus(owner.access_token).expect(200);

    expect(res.body.uploaded_parts).toEqual([
      { part_number: 1, size: 5 * MIB },
      { part_number: 3, size: MIB },
    ]);
  });

  // 2. Negar consulta fora de `draft` e a não donos

  test('video-em-processing-retorna-invalid-video-status', async () => {
    const result = await dataSource.getRepository(Video).update(
      { id: video.id },
      {
        status: VideoStatus.Processing,
        processing_started_at: () => 'now()',
      },
    );
    expect(result.affected).toBe(1);

    const res = await getUploadStatus(owner.access_token).expect(409);

    expect(res.body.error).toBe('INVALID_VIDEO_STATUS');
  });

  test('nao-dono-recebe-video-not-found', async () => {
    const res = await getUploadStatus(stranger.access_token).expect(404);

    expect(res.body.error).toBe('VIDEO_NOT_FOUND');
  });
});
