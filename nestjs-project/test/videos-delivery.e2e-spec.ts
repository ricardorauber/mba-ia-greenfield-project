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
  videoThumbnailKey,
} from '../src/videos/video-storage-keys';
import {
  type AuthenticatedUser,
  createAuthenticatedUser,
} from './helpers/auth.helper';

const ORIGINAL_SIZE = 4096;
const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const DELIVERY_ROUTES = ['stream', 'download', 'thumbnail'] as const;

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

describe('videos-delivery', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storage: StorageService;
  let owner: AuthenticatedUser;
  let stranger: AuthenticatedUser;
  let videoId: string;
  const createdVideos = new Map<string, string>();

  // supertest does not follow redirects, so the 302 itself is observable
  const deliver = (
    route: (typeof DELIVERY_ROUTES)[number],
    token: string,
    target: INestApplication<App> = app,
    id: string = videoId,
  ) =>
    request(target.getHttpServer())
      .get(`/videos/${id}/${route}`)
      .set('Authorization', `Bearer ${token}`);

  async function createVideo(
    target: INestApplication<App>,
    token: string,
  ): Promise<string> {
    const res = await request(target.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        file_name: 'clip.mp4',
        mime_type: 'video/mp4',
        size: ORIGINAL_SIZE,
      })
      .expect(201);
    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: res.body.id });
    createdVideos.set(row.id, row.upload_id);
    return row.id;
  }

  // Ready without a worker: objects written by the internal client + row update
  async function makeReady(id: string): Promise<void> {
    await storage.putObject(
      videoOriginalKey(id),
      randomBytes(ORIGINAL_SIZE),
      'video/mp4',
    );
    await storage.putObject(videoThumbnailKey(id), TINY_JPEG, 'image/jpeg');
    const result = await dataSource.getRepository(Video).update(
      { id },
      {
        status: VideoStatus.Ready,
        size: ORIGINAL_SIZE,
        has_thumbnail: true,
      },
    );
    expect(result.affected).toBe(1);
  }

  const setStatus = async (status: VideoStatus): Promise<void> => {
    const result = await dataSource
      .getRepository(Video)
      .update({ id: videoId }, { status });
    expect(result.affected).toBe(1);
  };

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

  // 1. Entregar vídeo `ready` ao dono por redirect pré-assinado

  describe('with the owner video ready', () => {
    beforeEach(async () => {
      await makeReady(videoId);
    });

    test('stream-redireciona-para-url-publica-com-ttl-default', async () => {
      const res = await deliver('stream', owner.access_token).expect(302);

      expect(
        res.headers.location.startsWith(process.env.S3_PUBLIC_ENDPOINT!),
      ).toBe(true);
      expect(res.headers.location).toContain('X-Amz-Expires=14400');
      expect(res.headers['cache-control']).toBe('private, no-store');
    });

    test('location-do-stream-atende-range-com-206', async () => {
      const res = await deliver('stream', owner.access_token).expect(302);

      const media = await fetch(res.headers.location, {
        headers: { Range: 'bytes=0-1023' },
      });
      const body = Buffer.from(await media.arrayBuffer());

      expect(media.status).toBe(206);
      expect(media.headers.get('content-range')).toBe(
        `bytes 0-1023/${ORIGINAL_SIZE}`,
      );
      expect(body).toHaveLength(1024);
    });

    test('download-responde-com-attachment-do-nome-original', async () => {
      const res = await deliver('download', owner.access_token).expect(302);
      expect(res.headers['cache-control']).toBe('private, no-store');

      const file = await fetch(res.headers.location);
      await file.arrayBuffer();

      expect(file.status).toBe(200);
      const disposition = file.headers.get('content-disposition')!;
      expect(disposition.startsWith('attachment')).toBe(true);
      expect(disposition).toContain('filename="clip.mp4"');
    });

    test('thumbnail-responde-jpeg', async () => {
      const res = await deliver('thumbnail', owner.access_token).expect(302);
      expect(res.headers['cache-control']).toBe('private, no-store');

      const image = await fetch(res.headers.location);
      await image.arrayBuffer();

      expect(image.status).toBe(200);
      expect(image.headers.get('content-type')).toBe('image/jpeg');
    });
  });

  describe('with S3_DELIVERY_URL_TTL_SECONDS=7200', () => {
    const originalTtl = process.env.S3_DELIVERY_URL_TTL_SECONDS;
    let shortTtlApp: INestApplication<App>;

    beforeAll(async () => {
      process.env.S3_DELIVERY_URL_TTL_SECONDS = '7200';
      shortTtlApp = await createApp();
    });

    afterAll(async () => {
      await shortTtlApp.close();
      if (originalTtl === undefined) {
        delete process.env.S3_DELIVERY_URL_TTL_SECONDS;
      } else {
        process.env.S3_DELIVERY_URL_TTL_SECONDS = originalTtl;
      }
    });

    test('ttl-de-entrega-configurado-reflete-no-location', async () => {
      clearThrottler(shortTtlApp);
      const user = await createAuthenticatedUser(shortTtlApp);
      const id = await createVideo(shortTtlApp, user.access_token);
      await makeReady(id);

      for (const route of DELIVERY_ROUTES) {
        const res = await deliver(
          route,
          user.access_token,
          shortTtlApp,
          id,
        ).expect(302);
        expect(res.headers.location).toContain('X-Amz-Expires=7200');
      }
    });
  });

  // 2. Negar entrega fora de `ready` e a não donos

  test('fora-de-ready-retorna-video-not-ready', async () => {
    for (const status of [
      VideoStatus.Draft,
      VideoStatus.Processing,
      VideoStatus.Failed,
    ]) {
      await setStatus(status);

      for (const route of DELIVERY_ROUTES) {
        const res = await deliver(route, owner.access_token).expect(409);
        expect(res.body.error).toBe('VIDEO_NOT_READY');
        expect(res.headers.location).toBeUndefined();
      }
    }
  });

  test('nao-dono-recebe-404-mesmo-fora-de-ready', async () => {
    for (const route of DELIVERY_ROUTES) {
      const res = await deliver(route, stranger.access_token).expect(404);
      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    }

    await makeReady(videoId);

    for (const route of DELIVERY_ROUTES) {
      const res = await deliver(route, stranger.access_token).expect(404);
      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    }
  });
});
