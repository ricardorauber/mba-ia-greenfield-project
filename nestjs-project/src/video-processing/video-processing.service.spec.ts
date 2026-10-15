import type { StorageService } from '../storage/storage.service';
import { type Video, VideoStatus } from '../videos/entities/video.entity';
import type { VideosService } from '../videos/videos.service';
import { MediaToolError } from './media/media-tool-error';
import type { MediaToolsService } from './media/media-tools.service';
import type { ProbeResult } from './media/probe-parser';
import { PermanentProcessingError } from './video-processing-errors';
import { VideoProcessingService } from './video-processing.service';

const VIDEO_ID = 'video-id';
const SOURCE_URL =
  'http://minio:9000/streamtube-videos/videos/video-id/original?sig';
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);

const probeResult = (overrides: Partial<ProbeResult> = {}): ProbeResult => ({
  duration: 10,
  size: 4096,
  format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
  bit_rate: 800000,
  width: 320,
  height: 240,
  video_codec: 'h264',
  audio_codec: 'aac',
  frame_rate: 25,
  ...overrides,
});

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('Expected the promise to reject');
}

describe('VideoProcessingService', () => {
  let videosService: { findById: jest.Mock; markReady: jest.Mock };
  let storageService: {
    presignInternalGet: jest.Mock;
    putObject: jest.Mock;
    headObject: jest.Mock;
  };
  let mediaTools: { probe: jest.Mock; extractFrame: jest.Mock };
  let service: VideoProcessingService;

  const video = (status: VideoStatus): Video =>
    ({ id: VIDEO_ID, status, mime_type: 'video/mp4' }) as Video;

  beforeEach(() => {
    videosService = {
      findById: jest.fn().mockResolvedValue(video(VideoStatus.Processing)),
      markReady: jest.fn().mockResolvedValue(true),
    };
    storageService = {
      presignInternalGet: jest.fn().mockResolvedValue(SOURCE_URL),
      putObject: jest.fn().mockResolvedValue(undefined),
      headObject: jest.fn().mockResolvedValue({ contentLength: 4096 }),
    };
    mediaTools = {
      probe: jest.fn().mockResolvedValue(probeResult()),
      extractFrame: jest.fn().mockResolvedValue(JPEG),
    };
    service = new VideoProcessingService(
      videosService as unknown as VideosService,
      storageService as unknown as StorageService,
      mediaTools as unknown as MediaToolsService,
    );
  });

  describe('idempotency', () => {
    it('should do nothing when the video no longer exists', async () => {
      videosService.findById.mockResolvedValue(null);

      await service.process(VIDEO_ID);

      expect(mediaTools.probe).not.toHaveBeenCalled();
      expect(videosService.markReady).not.toHaveBeenCalled();
    });

    it.each([VideoStatus.Draft, VideoStatus.Ready, VideoStatus.Failed])(
      'should do nothing for a video in %s',
      async (status) => {
        videosService.findById.mockResolvedValue(video(status));

        await service.process(VIDEO_ID);

        expect(storageService.presignInternalGet).not.toHaveBeenCalled();
        expect(storageService.putObject).not.toHaveBeenCalled();
        expect(videosService.markReady).not.toHaveBeenCalled();
      },
    );
  });

  describe('thumbnail position', () => {
    it.each([
      [0.5, 0],
      [0.999, 0],
      [1, 0.1],
      [10, 1],
    ])('should take the frame of a %ss clip at %ss', async (duration, at) => {
      mediaTools.probe.mockResolvedValue(probeResult({ duration }));

      await service.process(VIDEO_ID);

      expect(mediaTools.extractFrame).toHaveBeenCalledWith(SOURCE_URL, at);
    });
  });

  it('should probe the internal URL, store the thumbnail and mark the video ready', async () => {
    await service.process(VIDEO_ID);

    expect(storageService.presignInternalGet).toHaveBeenCalledWith(
      'videos/video-id/original',
    );
    expect(mediaTools.probe).toHaveBeenCalledWith(SOURCE_URL);
    expect(storageService.putObject).toHaveBeenCalledWith(
      'videos/video-id/thumbnail.jpg',
      JPEG,
      'image/jpeg',
    );
    expect(videosService.markReady).toHaveBeenCalledWith(VIDEO_ID, {
      duration: 10,
      width: 320,
      height: 240,
      size: 4096,
      metadata: {
        video_codec: 'h264',
        audio_codec: 'aac',
        format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
        bit_rate: 800000,
        frame_rate: 25,
      },
      has_thumbnail: true,
    });
  });

  it('should record the stored object size, not the probed one', async () => {
    storageService.headObject.mockResolvedValue({ contentLength: 9999 });

    await service.process(VIDEO_ID);

    expect(videosService.markReady.mock.calls[0][1].size).toBe(9999);
  });

  it('should not throw when the ready transition is lost to a concurrent actor', async () => {
    videosService.markReady.mockResolvedValue(false);

    await expect(service.process(VIDEO_ID)).resolves.toBeUndefined();
  });

  describe('permanent failures', () => {
    it('should turn invalid media from ffprobe into a permanent error', async () => {
      mediaTools.probe.mockRejectedValue(
        new MediaToolError('invalid_media', 'moov atom not found'),
      );

      const error = await captureError(service.process(VIDEO_ID));

      expect(error).toBeInstanceOf(PermanentProcessingError);
      expect((error as PermanentProcessingError).reason).toBe('invalid_media');
      expect(storageService.putObject).not.toHaveBeenCalled();
    });

    it('should turn invalid media from frame extraction into a permanent error', async () => {
      mediaTools.extractFrame.mockRejectedValue(
        new MediaToolError('invalid_media', 'ffmpeg produced no frame'),
      );

      const error = await captureError(service.process(VIDEO_ID));

      expect((error as PermanentProcessingError).reason).toBe('invalid_media');
    });

    it('should fail with unsupported_format before extracting a thumbnail', async () => {
      mediaTools.probe.mockResolvedValue(probeResult({ video_codec: 'mpeg4' }));

      const error = await captureError(service.process(VIDEO_ID));

      expect((error as PermanentProcessingError).reason).toBe(
        'unsupported_format',
      );
      expect(mediaTools.extractFrame).not.toHaveBeenCalled();
      expect(storageService.putObject).not.toHaveBeenCalled();
    });

    it('should fail with invalid_media when no duration is known', async () => {
      mediaTools.probe.mockResolvedValue(probeResult({ duration: null }));

      const error = await captureError(service.process(VIDEO_ID));

      expect((error as PermanentProcessingError).reason).toBe('invalid_media');
      expect(storageService.putObject).not.toHaveBeenCalled();
    });
  });

  describe('transient failures', () => {
    it('should rethrow a transient media-tool error unchanged', async () => {
      const transient = new MediaToolError('transient', 'Connection refused');
      mediaTools.probe.mockRejectedValue(transient);

      await expect(service.process(VIDEO_ID)).rejects.toBe(transient);
    });

    it('should rethrow a storage failure unchanged', async () => {
      const storageError = new Error('S3 unavailable');
      storageService.putObject.mockRejectedValue(storageError);

      await expect(service.process(VIDEO_ID)).rejects.toBe(storageError);
      expect(videosService.markReady).not.toHaveBeenCalled();
    });

    it('should not treat a missing original as permanent', async () => {
      storageService.headObject.mockResolvedValue(null);

      const error = await captureError(service.process(VIDEO_ID));

      expect(error).not.toBeInstanceOf(PermanentProcessingError);
      expect(videosService.markReady).not.toHaveBeenCalled();
    });
  });
});
