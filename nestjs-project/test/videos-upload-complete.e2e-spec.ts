import { randomBytes } from 'crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { VideoProcessingProducer } from '../src/video-processing/video-processing.producer';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from '../src/video-processing/video-processing.queue';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import {
  videoOriginalKey,
  videoPrefix,
} from '../src/videos/video-storage-keys';
import {
  type AuthenticatedUser,
  createAuthenticatedUser,
} from './helpers/auth.helper';

describe('videos-upload-complete', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storage: StorageService;
  let queue: Queue;
  let throttlerStorage: ThrottlerStorageService;
  let owner: AuthenticatedUser;
  let stranger: AuthenticatedUser;
  let videoId: string;
  const createdVideos = new Map<string, string>();

  const authed = (
    method: 'get' | 'post',
    path: string,
    token: string = owner.access_token,
  ) =>
    request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${token}`);

  const complete = (id: string = videoId, token?: string) =>
    authed('post', `/videos/${id}/upload/complete`, token);

  async function createVideo(size: number): Promise<string> {
    const res = await authed('post', '/videos')
      .send({ file_name: 'clip.mp4', mime_type: 'video/mp4', size })
      .expect(201);
    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: res.body.id });
    createdVideos.set(row.id, row.upload_id);
    return row.id;
  }

  async function uploadPart(
    id: string,
    partNumber: number,
    size: number,
  ): Promise<Response> {
    const res = await authed('post', `/videos/${id}/upload/part-urls`)
      .send({ part_numbers: [partNumber] })
      .expect(200);
    return fetch(res.body.parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(randomBytes(size)),
    });
  }

  const videoRow = (id: string = videoId) =>
    dataSource.getRepository(Video).findOneByOrFail({ id });

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
    queue = moduleFixture.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    for (const [id, uploadId] of createdVideos) {
      await storage.abortMultipartUpload(videoOriginalKey(id), uploadId);
      await storage.deletePrefix(videoPrefix(id));
    }
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
    // Two users = 6 auth requests against a 10/min limit
    throttlerStorage.storage.clear();
    owner = await createAuthenticatedUser(app);
    stranger = await createAuthenticatedUser(app);

    // part_count 1: the single part is the whole file
    videoId = await createVideo(1048576);
    const put = await uploadPart(videoId, 1, 1048576);
    expect(put.status).toBe(200);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // 1. Concluir o upload e disparar o processamento

  test('conclui-e-move-para-processing', async () => {
    const res = await complete().expect(200);
    expect(res.body).toMatchObject({ id: videoId, status: 'processing' });

    const read = await authed('get', `/videos/${videoId}`).expect(200);
    expect(read.body.status).toBe('processing');
    expect((await videoRow()).processing_started_at).toBeInstanceOf(Date);
    await expect(
      storage.headObject(videoOriginalKey(videoId)),
    ).resolves.toEqual({ contentLength: 1048576 });
  });

  test('job-process-video-enfileirado-com-job-id-do-video', async () => {
    await complete().expect(200);

    const job = await queue.getJob(videoId);
    expect(job).toBeDefined();
    expect(job!.name).toBe(PROCESS_VIDEO_JOB);
    expect(job!.id).toBe(videoId);
    expect(job!.data.videoId).toBe(videoId);
  });

  test('segunda-conclusao-e-replay-idempotente', async () => {
    const first = await complete().expect(200);
    expect(first.body.status).toBe('processing');
    const firstJob = await queue.getJob(videoId);

    const replay = await complete().expect(200);

    expect(replay.body.status).toBe('processing');
    const counts = await queue.getJobCounts();
    expect(Object.values(counts).reduce((sum, n) => sum + n, 0)).toBe(1);
    const job = await queue.getJob(videoId);
    expect(job!.id).toBe(firstJob!.id);
    expect(job!.timestamp).toBe(firstJob!.timestamp);
  });

  test('redis-indisponivel-no-enqueue-ainda-conclui', async () => {
    jest
      .spyOn(app.get(VideoProcessingProducer), 'enqueue')
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED redis:6379'));

    const res = await complete().expect(200);

    expect(res.body.status).toBe('processing');
    expect((await videoRow()).status).toBe(VideoStatus.Processing);
    await expect(queue.getJob(videoId)).resolves.toBeUndefined();
  });

  // 2. Rejeitar conclusão inválida e não donos

  test('parte-faltando-retorna-upload-incomplete-e-mantem-draft', async () => {
    // part_count 2; only the last part (1 byte) is uploaded
    const id = await createVideo(67108865);
    const put = await uploadPart(id, 2, 1);
    expect(put.status).toBe(200);
    expect(put.headers.get('etag')).toBeTruthy();

    const res = await complete(id).expect(409);

    expect(res.body.error).toBe('UPLOAD_INCOMPLETE');
    const read = await authed('get', `/videos/${id}`).expect(200);
    expect(read.body.status).toBe('draft');
    const status = await authed('get', `/videos/${id}/upload`).expect(200);
    expect(status.body.uploaded_parts).toEqual([{ part_number: 2, size: 1 }]);
  });

  test('video-failed-retorna-invalid-video-status', async () => {
    const result = await dataSource
      .getRepository(Video)
      .update(
        { id: videoId },
        { status: VideoStatus.Failed, failure_reason: 'upload_abandoned' },
      );
    expect(result.affected).toBe(1);

    const res = await complete().expect(409);

    expect(res.body.error).toBe('INVALID_VIDEO_STATUS');
    await expect(queue.getJob(videoId)).resolves.toBeUndefined();
  });

  test('nao-dono-recebe-video-not-found', async () => {
    const res = await complete(videoId, stranger.access_token).expect(404);

    expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    expect((await videoRow()).status).toBe(VideoStatus.Draft);
    await expect(queue.getJob(videoId)).resolves.toBeUndefined();
  });
});
