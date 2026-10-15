import { randomUUID } from 'crypto';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { configModuleOptions } from '../../config/config-module.options';
import { StorageModule } from '../../storage/storage.module';
import { StorageService } from '../../storage/storage.service';
import {
  createVideoFixtures,
  type VideoFixtures,
} from '../../test/video-fixtures';
import { MediaToolError } from './media-tool-error';
import { MediaToolsService } from './media-tools.service';

const JPEG_MAGIC = Buffer.from([0xff, 0xd8]);

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('Expected the promise to reject');
}

describe('MediaToolsService (integration, ffmpeg + MinIO)', () => {
  jest.setTimeout(120_000);

  let fixtures: VideoFixtures;
  let module: TestingModule;
  let media: MediaToolsService;
  let storage: StorageService;
  const prefix = `media-it/${randomUUID()}/`;

  beforeAll(async () => {
    fixtures = await createVideoFixtures();
    module = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(configModuleOptions), StorageModule],
      providers: [MediaToolsService],
    }).compile();
    media = module.get(MediaToolsService);
    storage = module.get(StorageService);
  });

  afterAll(async () => {
    await storage?.deletePrefix(prefix);
    await module?.close();
    await fixtures?.cleanup();
  });

  // The JPEG goes through ffprobe too, which reads its real dimensions
  async function probeJpeg(jpeg: Buffer): Promise<{ w: number; h: number }> {
    const path = join(fixtures.dir, `${randomUUID()}.jpg`);
    await writeFile(path, jpeg);
    const { width, height } = await media.probe(path);
    return { w: width, h: height };
  }

  describe('probe', () => {
    it('should read the metadata of an H.264/AAC MP4', async () => {
      const result = await media.probe(fixtures.mp4);

      expect(result.duration).toBeCloseTo(3, 0);
      expect(result).toMatchObject({
        width: 320,
        height: 240,
        video_codec: 'h264',
        audio_codec: 'aac',
        frame_rate: 25,
      });
      expect(result.format_name).toContain('mp4');
    });

    it('should read the metadata of a VP9/Opus WebM', async () => {
      const result = await media.probe(fixtures.webm);

      expect(result).toMatchObject({
        video_codec: 'vp9',
        audio_codec: 'opus',
      });
      expect(result.format_name).toContain('webm');
    });

    it('should report a null audio codec for an MP4 without audio', async () => {
      const result = await media.probe(fixtures.mp4NoAudio);

      expect(result.audio_codec).toBeNull();
    });

    it('should read the codec of MPEG-4 Part 2 video', async () => {
      const result = await media.probe(fixtures.mp4Mpeg4Part2);

      expect(result.video_codec).toBe('mpeg4');
    });

    it('should probe through an internal presigned MinIO URL without downloading', async () => {
      const key = `${prefix}original`;
      await storage.putObject(key, await readFile(fixtures.mp4), 'video/mp4');
      const url = await storage.presignInternalGet(key);

      const result = await media.probe(url);

      expect(url).toMatch(/^http:\/\/minio:9000\//);
      expect(result).toMatchObject({
        width: 320,
        height: 240,
        video_codec: 'h264',
      });
    });

    it('should fail with invalid_media for a corrupt file', async () => {
      const error = await captureError(media.probe(fixtures.mp4Corrupt));

      expect(error).toBeInstanceOf(MediaToolError);
      expect((error as MediaToolError).kind).toBe('invalid_media');
    });

    it('should fail with transient for an unreachable storage URL', async () => {
      const error = await captureError(
        media.probe('http://127.0.0.1:1/streamtube-videos/missing'),
      );

      expect(error).toBeInstanceOf(MediaToolError);
      expect((error as MediaToolError).kind).toBe('transient');
    });

    it('should fail with a classified error for a missing object', async () => {
      const url = await storage.presignInternalGet(`${prefix}does-not-exist`);

      const error = await captureError(media.probe(url));

      expect(error).toBeInstanceOf(MediaToolError);
      expect((error as MediaToolError).kind).toBe('transient');
    });
  });

  describe('extractFrame', () => {
    it('should scale a 1920x1080 frame down to a 1280x720 JPEG', async () => {
      const jpeg = await media.extractFrame(fixtures.mp4FullHd, 0.1);

      expect(jpeg.subarray(0, 2).equals(JPEG_MAGIC)).toBe(true);
      await expect(probeJpeg(jpeg)).resolves.toEqual({ w: 1280, h: 720 });
    });

    it('should keep a 320x240 frame at its size', async () => {
      const jpeg = await media.extractFrame(fixtures.mp4, 0.3);

      expect(jpeg.subarray(0, 2).equals(JPEG_MAGIC)).toBe(true);
      await expect(probeJpeg(jpeg)).resolves.toEqual({ w: 320, h: 240 });
    });

    it('should extract the first frame of a sub-second clip', async () => {
      const jpeg = await media.extractFrame(fixtures.mp4Short, 0);

      expect(jpeg.subarray(0, 2).equals(JPEG_MAGIC)).toBe(true);
    });

    it('should extract a frame through an internal presigned MinIO URL', async () => {
      const key = `${prefix}full-hd`;
      await storage.putObject(
        key,
        await readFile(fixtures.mp4FullHd),
        'video/mp4',
      );
      const url = await storage.presignInternalGet(key);

      const jpeg = await media.extractFrame(url, 0.1);

      expect(jpeg.subarray(0, 2).equals(JPEG_MAGIC)).toBe(true);
    });

    it('should fail with invalid_media for a corrupt file', async () => {
      const error = await captureError(
        media.extractFrame(fixtures.mp4Corrupt, 0),
      );

      expect(error).toBeInstanceOf(MediaToolError);
      expect((error as MediaToolError).kind).toBe('invalid_media');
    });
  });
});
