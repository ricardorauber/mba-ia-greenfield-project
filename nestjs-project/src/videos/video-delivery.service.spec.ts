import type { StorageService } from '../storage/storage.service';
import { type Video, VideoStatus } from './entities/video.entity';
import {
  VideoNotFoundException,
  VideoNotReadyException,
} from './exceptions/video.exceptions';
import { VideoDeliveryService } from './video-delivery.service';
import type { VideosService } from './videos.service';

type DeliveryMethod = 'getStreamUrl' | 'getDownloadUrl' | 'getThumbnailUrl';
const ALL_METHODS: DeliveryMethod[] = [
  'getStreamUrl',
  'getDownloadUrl',
  'getThumbnailUrl',
];

describe('VideoDeliveryService', () => {
  let videosService: { findOwnedOrFail: jest.Mock };
  let storageService: { presignGet: jest.Mock };
  let service: VideoDeliveryService;

  const video = (overrides: Partial<Video> = {}): Video =>
    ({
      id: 'video-id',
      status: VideoStatus.Ready,
      has_thumbnail: true,
      original_filename: 'clip.mp4',
      ...overrides,
    }) as Video;

  beforeEach(() => {
    videosService = { findOwnedOrFail: jest.fn().mockResolvedValue(video()) };
    storageService = {
      presignGet: jest
        .fn()
        .mockResolvedValue({ url: 'https://signed', expiresIn: 14400 }),
    };
    service = new VideoDeliveryService(
      videosService as unknown as VideosService,
      storageService as unknown as StorageService,
    );
  });

  describe.each(ALL_METHODS)('%s', (method) => {
    it('should check ownership before the status', async () => {
      // A non-owner's draft must look like a missing video, not a draft
      videosService.findOwnedOrFail.mockRejectedValue(
        new VideoNotFoundException(),
      );

      await expect(
        service[method]('stranger-id', 'video-id'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(storageService.presignGet).not.toHaveBeenCalled();
    });

    it.each([VideoStatus.Draft, VideoStatus.Processing, VideoStatus.Failed])(
      'should reject a video in %s',
      async (status) => {
        videosService.findOwnedOrFail.mockResolvedValue(video({ status }));

        await expect(
          service[method]('user-id', 'video-id'),
        ).rejects.toBeInstanceOf(VideoNotReadyException);
        expect(storageService.presignGet).not.toHaveBeenCalled();
      },
    );

    it('should return the presigned URL of a ready video', async () => {
      await expect(service[method]('user-id', 'video-id')).resolves.toBe(
        'https://signed',
      );
    });
  });

  it('should sign the original for streaming without a disposition', async () => {
    await service.getStreamUrl('user-id', 'video-id');

    expect(storageService.presignGet).toHaveBeenCalledWith(
      'videos/video-id/original',
    );
  });

  it('should sign the original for download as an attachment with the original name', async () => {
    videosService.findOwnedOrFail.mockResolvedValue(
      video({ original_filename: 'férias.mp4' }),
    );

    await service.getDownloadUrl('user-id', 'video-id');

    expect(storageService.presignGet).toHaveBeenCalledWith(
      'videos/video-id/original',
      {
        responseContentDisposition: `attachment; filename="f_rias.mp4"; filename*=UTF-8''f%C3%A9rias.mp4`,
      },
    );
  });

  it('should sign the thumbnail key', async () => {
    await service.getThumbnailUrl('user-id', 'video-id');

    expect(storageService.presignGet).toHaveBeenCalledWith(
      'videos/video-id/thumbnail.jpg',
    );
  });

  it('should reject the thumbnail of a ready video without one', async () => {
    videosService.findOwnedOrFail.mockResolvedValue(
      video({ has_thumbnail: false }),
    );

    await expect(
      service.getThumbnailUrl('user-id', 'video-id'),
    ).rejects.toBeInstanceOf(VideoNotReadyException);
  });
});
