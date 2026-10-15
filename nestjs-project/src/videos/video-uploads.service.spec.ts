import type { ChannelsService } from '../channels/channels.service';
import type { Channel } from '../channels/entities/channel.entity';
import type { StorageService } from '../storage/storage.service';
import type { CreateVideoDto } from './dto/create-video.dto';
import type { Video } from './entities/video.entity';
import {
  ChannelNotFoundException,
  UnsupportedVideoFormatException,
  VideoTooLargeException,
} from './exceptions/video.exceptions';
import { VideoUploadsService } from './video-uploads.service';
import type { VideosService } from './videos.service';

const MIB = 1024 ** 2;
const TEN_GIB = 10 * 1024 ** 3;

describe('VideoUploadsService', () => {
  let videosService: { createDraft: jest.Mock };
  let channelsService: { findByUserId: jest.Mock };
  let storageService: {
    createMultipartUpload: jest.Mock;
    abortMultipartUpload: jest.Mock;
  };
  let service: VideoUploadsService;
  const channel = { id: 'channel-id' } as Channel;
  const video = { id: 'video-id' } as Video;

  const dto = (overrides: Partial<CreateVideoDto> = {}): CreateVideoDto => ({
    file_name: 'clip.mp4',
    mime_type: 'video/mp4',
    size: MIB,
    ...overrides,
  });

  beforeEach(() => {
    videosService = { createDraft: jest.fn().mockResolvedValue(video) };
    channelsService = { findByUserId: jest.fn().mockResolvedValue(channel) };
    storageService = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-id'),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    };
    service = new VideoUploadsService(
      videosService as unknown as VideosService,
      channelsService as unknown as ChannelsService,
      storageService as unknown as StorageService,
    );
  });

  describe('format validation', () => {
    it('should reject a MIME type outside the allowlist', async () => {
      await expect(
        service.initiate(
          'user-id',
          dto({ file_name: 'clip.mov', mime_type: 'video/quicktime' }),
        ),
      ).rejects.toBeInstanceOf(UnsupportedVideoFormatException);
      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('should reject an extension that does not match the MIME type', async () => {
      await expect(
        service.initiate('user-id', dto({ file_name: 'clip.webm' })),
      ).rejects.toBeInstanceOf(UnsupportedVideoFormatException);
    });

    it('should reject a file name without extension', async () => {
      await expect(
        service.initiate('user-id', dto({ file_name: 'clip' })),
      ).rejects.toBeInstanceOf(UnsupportedVideoFormatException);
    });

    it('should accept an upper-case extension', async () => {
      await expect(
        service.initiate(
          'user-id',
          dto({ file_name: 'CLIP.WEBM', mime_type: 'video/webm' }),
        ),
      ).resolves.toMatchObject({ video });
    });
  });

  describe('size validation', () => {
    it('should accept exactly 10 GiB', async () => {
      await expect(
        service.initiate('user-id', dto({ size: TEN_GIB })),
      ).resolves.toMatchObject({ video });
    });

    it('should reject one byte over 10 GiB', async () => {
      await expect(
        service.initiate('user-id', dto({ size: TEN_GIB + 1 })),
      ).rejects.toBeInstanceOf(VideoTooLargeException);
      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    });
  });

  it('should reject a user without a channel', async () => {
    channelsService.findByUserId.mockResolvedValue(null);

    await expect(service.initiate('user-id', dto())).rejects.toBeInstanceOf(
      ChannelNotFoundException,
    );
    expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
  });

  describe('draft creation', () => {
    it('should open the multipart upload under the video key and register the draft', async () => {
      await service.initiate('user-id', dto());

      const [key, contentType] =
        storageService.createMultipartUpload.mock.calls[0];
      const draft = videosService.createDraft.mock.calls[0][0];
      expect(contentType).toBe('video/mp4');
      expect(key).toBe(`videos/${draft.id}/original`);
      expect(draft).toMatchObject({
        channelId: 'channel-id',
        originalFilename: 'clip.mp4',
        mimeType: 'video/mp4',
        declaredSize: MIB,
        uploadId: 'upload-id',
      });
    });

    it('should default the title to the file name without extension', async () => {
      await service.initiate('user-id', dto({ file_name: 'My Trip.MP4' }));

      expect(videosService.createDraft.mock.calls[0][0].title).toBe('My Trip');
    });

    it('should truncate the default title to 100 characters', async () => {
      const longName = 'a'.repeat(150);

      await service.initiate('user-id', dto({ file_name: `${longName}.mp4` }));

      expect(videosService.createDraft.mock.calls[0][0].title).toBe(
        'a'.repeat(100),
      );
    });

    it('should keep an explicit title', async () => {
      await service.initiate('user-id', dto({ title: 'Custom title' }));

      expect(videosService.createDraft.mock.calls[0][0].title).toBe(
        'Custom title',
      );
    });

    it('should abort the multipart upload and rethrow when the draft cannot be created', async () => {
      const error = new Error('db down');
      videosService.createDraft.mockRejectedValue(error);

      await expect(service.initiate('user-id', dto())).rejects.toBe(error);

      const [key] = storageService.createMultipartUpload.mock.calls[0];
      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        key,
        'upload-id',
      );
    });

    it('should still rethrow the original error when the abort also fails', async () => {
      const error = new Error('db down');
      videosService.createDraft.mockRejectedValue(error);
      storageService.abortMultipartUpload.mockRejectedValue(
        new Error('storage down'),
      );

      await expect(service.initiate('user-id', dto())).rejects.toBe(error);
    });
  });

  describe('upload plan', () => {
    it.each([
      [1, 1],
      [64 * MIB, 1],
      [64 * MIB + 1, 2],
      [TEN_GIB, 160],
    ])('should plan %i bytes as %i part(s) of 64 MiB', async (size, parts) => {
      const { upload } = await service.initiate('user-id', dto({ size }));

      expect(upload).toEqual({ part_size: 64 * MIB, part_count: parts });
    });
  });
});
