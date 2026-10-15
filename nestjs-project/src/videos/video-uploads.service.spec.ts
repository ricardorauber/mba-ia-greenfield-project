import { S3ServiceException } from '@aws-sdk/client-s3';
import type { ChannelsService } from '../channels/channels.service';
import type { Channel } from '../channels/entities/channel.entity';
import type { StorageService } from '../storage/storage.service';
import type { VideoProcessingProducer } from '../video-processing/video-processing.producer';
import type { CreateVideoDto } from './dto/create-video.dto';
import { type Video, VideoStatus } from './entities/video.entity';
import {
  ChannelNotFoundException,
  InvalidPartNumberException,
  InvalidVideoStatusException,
  UnsupportedVideoFormatException,
  UploadIncompleteException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoTooLargeException,
} from './exceptions/video.exceptions';
import { VideoUploadsService } from './video-uploads.service';
import type { VideosService } from './videos.service';

const MIB = 1024 ** 2;
const TEN_GIB = 10 * 1024 ** 3;

describe('VideoUploadsService', () => {
  let videosService: {
    createDraft: jest.Mock;
    findOwnedOrFail: jest.Mock;
    markProcessing: jest.Mock;
    markFailed: jest.Mock;
  };
  let channelsService: { findByUserId: jest.Mock };
  let storageService: {
    createMultipartUpload: jest.Mock;
    abortMultipartUpload: jest.Mock;
    listParts: jest.Mock;
    presignUploadPart: jest.Mock;
    completeMultipartUpload: jest.Mock;
    headObject: jest.Mock;
    deleteObject: jest.Mock;
  };
  let processingProducer: { enqueue: jest.Mock };
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
    videosService = {
      createDraft: jest.fn().mockResolvedValue(video),
      findOwnedOrFail: jest.fn(),
      markProcessing: jest.fn().mockResolvedValue(true),
      markFailed: jest.fn().mockResolvedValue(true),
    };
    channelsService = { findByUserId: jest.fn().mockResolvedValue(channel) };
    storageService = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-id'),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      listParts: jest.fn(),
      presignUploadPart: jest.fn(),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      headObject: jest.fn(),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };
    processingProducer = { enqueue: jest.fn().mockResolvedValue(undefined) };
    service = new VideoUploadsService(
      videosService as unknown as VideosService,
      channelsService as unknown as ChannelsService,
      storageService as unknown as StorageService,
      processingProducer as unknown as VideoProcessingProducer,
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

  describe('getUploadStatus', () => {
    const draft = (overrides: Partial<Video> = {}): Video =>
      ({
        id: 'video-id',
        status: VideoStatus.Draft,
        declared_size: 2 * 64 * MIB + 1,
        upload_id: 'upload-id',
        ...overrides,
      }) as Video;

    it.each([VideoStatus.Processing, VideoStatus.Ready, VideoStatus.Failed])(
      'should reject a video in %s',
      async (status) => {
        videosService.findOwnedOrFail.mockResolvedValue(draft({ status }));

        await expect(
          service.getUploadStatus('user-id', 'video-id'),
        ).rejects.toBeInstanceOf(InvalidVideoStatusException);
        expect(storageService.listParts).not.toHaveBeenCalled();
      },
    );

    it('should propagate VideoNotFoundException before checking the status', async () => {
      videosService.findOwnedOrFail.mockRejectedValue(
        new VideoNotFoundException(),
      );

      await expect(
        service.getUploadStatus('user-id', 'video-id'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('should list the stored parts of the video original', async () => {
      videosService.findOwnedOrFail.mockResolvedValue(draft());
      storageService.listParts.mockResolvedValue([
        { partNumber: 1, size: 64 * MIB, etag: '"a"' },
        { partNumber: 3, size: 1, etag: '"c"' },
      ]);

      const status = await service.getUploadStatus('user-id', 'video-id');

      expect(storageService.listParts).toHaveBeenCalledWith(
        'videos/video-id/original',
        'upload-id',
      );
      expect(status).toEqual({
        part_size: 64 * MIB,
        part_count: 3,
        uploaded_parts: [
          { part_number: 1, size: 64 * MIB },
          { part_number: 3, size: 1 },
        ],
      });
    });

    it('should report no parts when the multipart upload no longer exists', async () => {
      videosService.findOwnedOrFail.mockResolvedValue(draft());
      storageService.listParts.mockResolvedValue(null);

      const status = await service.getUploadStatus('user-id', 'video-id');

      expect(status.uploaded_parts).toEqual([]);
    });

    it.each([
      [1, 1],
      [64 * MIB, 1],
      [TEN_GIB, 160],
    ])(
      'should derive part_count from a declared size of %i bytes as %i',
      async (declaredSize, parts) => {
        videosService.findOwnedOrFail.mockResolvedValue(
          draft({ declared_size: declaredSize }),
        );
        storageService.listParts.mockResolvedValue([]);

        const status = await service.getUploadStatus('user-id', 'video-id');

        expect(status.part_count).toBe(parts);
      },
    );
  });

  describe('presignParts', () => {
    const draft = (overrides: Partial<Video> = {}): Video =>
      ({
        id: 'video-id',
        status: VideoStatus.Draft,
        // 3 parts of 64 MiB (the last one is 1 byte)
        declared_size: 2 * 64 * MIB + 1,
        upload_id: 'upload-id',
        ...overrides,
      }) as Video;

    beforeEach(() => {
      storageService.presignUploadPart.mockImplementation(
        (_key: string, _uploadId: string, partNumber: number) =>
          Promise.resolve({
            url: `https://signed/${partNumber}`,
            expiresIn: 900,
          }),
      );
    });

    it('should reject a part number above part_count', async () => {
      videosService.findOwnedOrFail.mockResolvedValue(draft());

      await expect(
        service.presignParts('user-id', 'video-id', [1, 4]),
      ).rejects.toBeInstanceOf(InvalidPartNumberException);
      expect(storageService.presignUploadPart).not.toHaveBeenCalled();
    });

    it('should accept the last part number', async () => {
      videosService.findOwnedOrFail.mockResolvedValue(draft());

      await expect(
        service.presignParts('user-id', 'video-id', [3]),
      ).resolves.toMatchObject({ parts: [{ part_number: 3 }] });
    });

    it.each([VideoStatus.Processing, VideoStatus.Ready, VideoStatus.Failed])(
      'should reject a video in %s',
      async (status) => {
        videosService.findOwnedOrFail.mockResolvedValue(draft({ status }));

        await expect(
          service.presignParts('user-id', 'video-id', [1]),
        ).rejects.toBeInstanceOf(InvalidVideoStatusException);
      },
    );

    it('should check ownership before the part range', async () => {
      videosService.findOwnedOrFail.mockRejectedValue(
        new VideoNotFoundException(),
      );

      await expect(
        service.presignParts('user-id', 'video-id', [99]),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('should sign the video original upload and keep the requested order', async () => {
      videosService.findOwnedOrFail.mockResolvedValue(draft());

      const result = await service.presignParts('user-id', 'video-id', [3, 1]);

      expect(storageService.presignUploadPart).toHaveBeenCalledWith(
        'videos/video-id/original',
        'upload-id',
        3,
      );
      expect(result.parts).toEqual([
        { part_number: 3, url: 'https://signed/3' },
        { part_number: 1, url: 'https://signed/1' },
      ]);
    });

    it('should report the TTL the storage signed the URLs with', async () => {
      videosService.findOwnedOrFail.mockResolvedValue(draft());

      const result = await service.presignParts('user-id', 'video-id', [1]);

      expect(result.expires_in).toBe(900);
    });
  });

  describe('complete', () => {
    // 2 parts: 64 MiB + 1 byte
    const DECLARED = 64 * MIB + 1;
    const draft = (overrides: Partial<Video> = {}): Video =>
      ({
        id: 'video-id',
        status: VideoStatus.Draft,
        declared_size: DECLARED,
        upload_id: 'upload-id',
        ...overrides,
      }) as Video;
    const allParts = [
      { partNumber: 1, size: 64 * MIB, etag: '"a"' },
      { partNumber: 2, size: 1, etag: '"b"' },
    ];
    const processing = draft({ status: VideoStatus.Processing });

    beforeEach(() => {
      videosService.findOwnedOrFail
        .mockResolvedValueOnce(draft())
        .mockResolvedValueOnce(processing);
      storageService.listParts.mockResolvedValue(allParts);
      storageService.headObject.mockResolvedValue({ contentLength: DECLARED });
    });

    it('should assemble the parts, move the video to processing and enqueue it', async () => {
      const result = await service.complete('user-id', 'video-id');

      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/video-id/original',
        'upload-id',
        allParts,
      );
      expect(videosService.markProcessing).toHaveBeenCalledWith('video-id');
      expect(processingProducer.enqueue).toHaveBeenCalledWith('video-id');
      expect(result).toBe(processing);
    });

    it.each([VideoStatus.Processing, VideoStatus.Ready])(
      'should replay a video in %s without side effects',
      async (status) => {
        const current = draft({ status });
        videosService.findOwnedOrFail.mockReset().mockResolvedValue(current);

        const result = await service.complete('user-id', 'video-id');

        expect(result).toBe(current);
        expect(storageService.listParts).not.toHaveBeenCalled();
        expect(videosService.markProcessing).not.toHaveBeenCalled();
        expect(processingProducer.enqueue).not.toHaveBeenCalled();
      },
    );

    it('should reject a failed video', async () => {
      videosService.findOwnedOrFail
        .mockReset()
        .mockResolvedValue(draft({ status: VideoStatus.Failed }));

      await expect(
        service.complete('user-id', 'video-id'),
      ).rejects.toBeInstanceOf(InvalidVideoStatusException);
      expect(storageService.listParts).not.toHaveBeenCalled();
    });

    it('should reject a missing part and leave the upload open', async () => {
      storageService.listParts.mockResolvedValue([allParts[1]]);

      await expect(
        service.complete('user-id', 'video-id'),
      ).rejects.toBeInstanceOf(UploadIncompleteException);
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
      expect(videosService.markProcessing).not.toHaveBeenCalled();
    });

    it('should reject parts whose sizes do not add up to the declared size', async () => {
      storageService.listParts.mockResolvedValue([
        allParts[0],
        { ...allParts[1], size: 2 },
      ]);

      await expect(
        service.complete('user-id', 'video-id'),
      ).rejects.toBeInstanceOf(UploadIncompleteException);
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('should map a too-small part rejected by storage to UploadIncompleteException and keep the draft', async () => {
      storageService.completeMultipartUpload.mockRejectedValue(
        new S3ServiceException({
          name: 'EntityTooSmall',
          $fault: 'client',
          $metadata: { httpStatusCode: 400 },
          message:
            'Your proposed upload is smaller than the minimum allowed size',
        }),
      );

      await expect(
        service.complete('user-id', 'video-id'),
      ).rejects.toBeInstanceOf(UploadIncompleteException);
      expect(storageService.deleteObject).not.toHaveBeenCalled();
      expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
      expect(videosService.markFailed).not.toHaveBeenCalled();
      expect(videosService.markProcessing).not.toHaveBeenCalled();
      expect(processingProducer.enqueue).not.toHaveBeenCalled();
    });

    it('should rethrow other storage errors from the assembly unchanged', async () => {
      const storageError = new S3ServiceException({
        name: 'InternalError',
        $fault: 'server',
        $metadata: { httpStatusCode: 500 },
      });
      storageService.completeMultipartUpload.mockRejectedValue(storageError);

      await expect(service.complete('user-id', 'video-id')).rejects.toBe(
        storageError,
      );
      expect(videosService.markProcessing).not.toHaveBeenCalled();
    });

    it('should continue when the upload was already assembled and the object exists', async () => {
      storageService.listParts.mockResolvedValue(null);

      await service.complete('user-id', 'video-id');

      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
      expect(videosService.markProcessing).toHaveBeenCalledWith('video-id');
    });

    it('should reject when neither the upload nor the object exists', async () => {
      storageService.listParts.mockResolvedValue(null);
      storageService.headObject.mockResolvedValue(null);

      await expect(
        service.complete('user-id', 'video-id'),
      ).rejects.toBeInstanceOf(UploadIncompleteException);
      expect(videosService.markProcessing).not.toHaveBeenCalled();
    });

    it('should delete the object and fail the video when the stored size differs', async () => {
      storageService.headObject.mockResolvedValue({
        contentLength: DECLARED + 1,
      });

      await expect(
        service.complete('user-id', 'video-id'),
      ).rejects.toBeInstanceOf(UploadSizeMismatchException);
      expect(storageService.deleteObject).toHaveBeenCalledWith(
        'videos/video-id/original',
      );
      expect(videosService.markFailed).toHaveBeenCalledWith(
        'video-id',
        'size_mismatch',
        VideoStatus.Draft,
      );
      expect(videosService.markProcessing).not.toHaveBeenCalled();
    });

    it('should report the lost transition when the sweep failed the draft meanwhile', async () => {
      videosService.markProcessing.mockResolvedValue(false);

      await expect(
        service.complete('user-id', 'video-id'),
      ).rejects.toBeInstanceOf(InvalidVideoStatusException);
      expect(processingProducer.enqueue).not.toHaveBeenCalled();
    });

    it('should still succeed when the enqueue fails', async () => {
      processingProducer.enqueue.mockRejectedValue(
        new Error('connect ECONNREFUSED redis:6379'),
      );

      await expect(service.complete('user-id', 'video-id')).resolves.toBe(
        processing,
      );
      expect(videosService.markProcessing).toHaveBeenCalled();
    });
  });
});
