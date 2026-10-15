import { execFile } from 'child_process';
import { mkdtemp, readFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { getQueueToken } from '@nestjs/bullmq';
import {
  type INestApplication,
  type INestApplicationContext,
  ValidationPipe,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
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
import { MediaToolsService } from '../src/video-processing/media/media-tools.service';
import {
  VIDEO_PROCESSING_QUEUE,
  VIDEO_RECONCILIATION_QUEUE,
} from '../src/video-processing/video-processing.queue';
import { Video } from '../src/videos/entities/video.entity';
import {
  videoOriginalKey,
  videoPrefix,
} from '../src/videos/video-storage-keys';
import { WorkerModule } from '../src/worker.module';
import {
  type AuthenticatedUser,
  createAuthenticatedUser,
} from './helpers/auth.helper';

const execFileAsync = promisify(execFile);

const MIB = 1024 * 1024;
const PART_SIZE = 64 * MIB;
// Comfortably above one part, so the upload needs exactly two
const MIN_FIXTURE_BYTES = PART_SIZE + 4 * MIB;
const SETTLE_TIMEOUT_MS = 120_000;

/**
 * Lossless H.264 (+AAC) at 1280x720 grows fast; lengthen the clip until it
 * exceeds one 64 MiB part.
 */
async function createLargeMp4(dir: string): Promise<string> {
  const output = join(dir, 'large.mp4');
  for (let seconds = 4; seconds <= 64; seconds *= 2) {
    await execFileAsync('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=duration=${seconds}:size=1280x720:rate=30`,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:duration=${seconds}`,
      '-c:v',
      'libx264',
      '-qp',
      '0',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      output,
    ]);
    if ((await stat(output)).size >= MIN_FIXTURE_BYTES) {
      return output;
    }
  }
  throw new Error('Could not generate an MP4 larger than one upload part');
}

async function createMpeg4Part2Mp4(dir: string): Promise<string> {
  const output = join(dir, 'mpeg4.mp4');
  await execFileAsync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=2:size=320x240:rate=25',
    '-c:v',
    'mpeg4',
    output,
  ]);
  return output;
}

describe('videos-pipeline', () => {
  jest.setTimeout(180_000);

  let fixturesDir: string;
  let largeMp4: Buffer;
  let mpeg4Mp4: Buffer;
  let app: INestApplication<App>;
  let worker: INestApplicationContext;
  let dataSource: DataSource;
  let storage: StorageService;
  let owner: AuthenticatedUser;
  const createdVideos = new Map<string, string>();
  const slugs: string[] = [];

  const api = () => request(app.getHttpServer());
  const authed = (method: 'get' | 'post', path: string) =>
    api()[method](path).set('Authorization', `Bearer ${owner.access_token}`);

  const queues = (): Queue[] =>
    [VIDEO_PROCESSING_QUEUE, VIDEO_RECONCILIATION_QUEUE].map((name) =>
      worker.get<Queue>(getQueueToken(name), { strict: false }),
    );

  async function createVideo(fileName: string, size: number) {
    const res = await authed('post', '/videos')
      .send({ file_name: fileName, mime_type: 'video/mp4', size })
      .expect(201);
    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: res.body.id });
    createdVideos.set(row.id, row.upload_id);
    slugs.push(res.body.slug);
    return res.body as {
      id: string;
      upload: { part_size: number; part_count: number };
    };
  }

  async function partUrls(id: string, partNumbers: number[]) {
    const res = await authed('post', `/videos/${id}/upload/part-urls`)
      .send({ part_numbers: partNumbers })
      .expect(200);
    return res.body.parts as { part_number: number; url: string }[];
  }

  // The client PUTs straight to storage: the API never sees the bytes
  async function putPart(url: string, bytes: Buffer): Promise<void> {
    expect(new URL(url).origin).toBe(process.env.S3_PUBLIC_ENDPOINT);
    const res = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(bytes),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBeTruthy();
  }

  const slice = (bytes: Buffer, partNumber: number): Buffer =>
    bytes.subarray((partNumber - 1) * PART_SIZE, partNumber * PART_SIZE);

  async function waitUntilSettled(id: string) {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const res = await authed('get', `/videos/${id}`).expect(200);
      if (res.body.status !== 'processing') {
        return res.body as Record<string, any>;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(
      `Video ${id} still processing after ${SETTLE_TIMEOUT_MS} ms`,
    );
  }

  async function redirectTarget(id: string, route: string): Promise<string> {
    const res = await authed('get', `/videos/${id}/${route}`).expect(302);
    expect(res.headers['cache-control']).toBe('private, no-store');
    return res.headers.location;
  }

  beforeAll(async () => {
    fixturesDir = await mkdtemp(join(tmpdir(), 'streamtube-pipeline-'));
    largeMp4 = await readFile(await createLargeMp4(fixturesDir));
    mpeg4Mp4 = await readFile(await createMpeg4Part2Mp4(fixturesDir));

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

    // The real worker in the same process, on the isolated test queue prefix
    worker = await NestFactory.createApplicationContext(WorkerModule, {
      logger: false,
    });

    dataSource = app.get(DataSource);
    storage = app.get(StorageService);
    for (const queue of queues()) {
      await queue.obliterate({ force: true });
    }
  });

  afterAll(async () => {
    for (const [id, uploadId] of createdVideos) {
      await storage?.abortMultipartUpload(videoOriginalKey(id), uploadId);
      await storage?.deletePrefix(videoPrefix(id));
    }
    if (worker) {
      for (const queue of queues()) {
        await queue.obliterate({ force: true });
      }
      await worker.close();
    }
    if (dataSource) {
      await cleanAllTables(dataSource);
    }
    await app?.close();
    await rm(fixturesDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    app.get<ThrottlerStorageService>(ThrottlerStorage).storage.clear();
    owner = await createAuthenticatedUser(app);
  });

  test('uploads a large MP4 in two parts, processes it and delivers it', async () => {
    const video = await createVideo('large.mp4', largeMp4.length);
    expect(video.upload).toEqual({ part_size: PART_SIZE, part_count: 2 });

    for (const part of await partUrls(video.id, [1, 2])) {
      await putPart(part.url, slice(largeMp4, part.part_number));
    }
    const completed = await authed(
      'post',
      `/videos/${video.id}/upload/complete`,
    ).expect(200);
    expect(completed.body.status).toBe('processing');

    const ready = await waitUntilSettled(video.id);
    expect(ready).toMatchObject({
      status: 'ready',
      width: 1280,
      height: 720,
      size: largeMp4.length,
      has_thumbnail: true,
      failure_reason: null,
    });
    expect(ready.duration).toBeGreaterThan(0);

    const streamUrl = await redirectTarget(video.id, 'stream');
    const stream = await fetch(streamUrl, {
      headers: { Range: 'bytes=0-1048575' },
    });
    const head = Buffer.from(await stream.arrayBuffer());
    expect(stream.status).toBe(206);
    expect(head.equals(largeMp4.subarray(0, MIB))).toBe(true);

    const download = await fetch(await redirectTarget(video.id, 'download'), {
      headers: { Range: 'bytes=0-0' },
    });
    await download.arrayBuffer();
    expect(download.headers.get('content-disposition')).toMatch(
      /^attachment; filename="large\.mp4"/,
    );

    const thumbnailUrl = await redirectTarget(video.id, 'thumbnail');
    const thumbnail = await fetch(thumbnailUrl);
    const jpeg = Buffer.from(await thumbnail.arrayBuffer());
    expect(thumbnail.headers.get('content-type')).toBe('image/jpeg');
    expect(jpeg.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(true);
    const thumbnailProbe = await worker
      .get(MediaToolsService, { strict: false })
      .probe(thumbnailUrl);
    expect(thumbnailProbe.width).toBeLessThanOrEqual(1280);
  });

  test('resumes an interrupted upload with only the missing part', async () => {
    const video = await createVideo('resumed.mp4', largeMp4.length);
    const [firstPart] = await partUrls(video.id, [1]);
    await putPart(firstPart.url, slice(largeMp4, 1));

    // The client lost its state: storage is the only source of truth
    const status = await authed('get', `/videos/${video.id}/upload`).expect(
      200,
    );
    expect(status.body.uploaded_parts).toEqual([
      { part_number: 1, size: PART_SIZE },
    ]);
    const missing = Array.from(
      { length: status.body.part_count as number },
      (_, i) => i + 1,
    ).filter(
      (n) =>
        !(status.body.uploaded_parts as { part_number: number }[]).some(
          (p) => p.part_number === n,
        ),
    );
    expect(missing).toEqual([2]);

    const [secondPart] = await partUrls(video.id, missing);
    await putPart(secondPart.url, slice(largeMp4, 2));
    await authed('post', `/videos/${video.id}/upload/complete`).expect(200);

    const settled = await waitUntilSettled(video.id);
    expect(settled.status).toBe('ready');
    expect(settled.size).toBe(largeMp4.length);
  });

  test('fails a codec outside the allowlist and refuses to stream it', async () => {
    const video = await createVideo('mpeg4.mp4', mpeg4Mp4.length);
    const [part] = await partUrls(video.id, [1]);
    await putPart(part.url, mpeg4Mp4);
    await authed('post', `/videos/${video.id}/upload/complete`).expect(200);

    const settled = await waitUntilSettled(video.id);
    expect(settled).toMatchObject({
      status: 'failed',
      failure_reason: 'unsupported_format',
      has_thumbnail: false,
    });

    const res = await authed('get', `/videos/${video.id}/stream`).expect(409);
    expect(res.body.error).toBe('VIDEO_NOT_READY');
  });

  test('gives every video a distinct slug', () => {
    expect(slugs).toHaveLength(3);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
