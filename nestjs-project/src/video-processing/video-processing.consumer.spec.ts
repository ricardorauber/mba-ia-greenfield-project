import { type Job, UnrecoverableError } from 'bullmq';
import { VideoStatus } from '../videos/entities/video.entity';
import type { VideosService } from '../videos/videos.service';
import { PermanentProcessingError } from './video-processing-errors';
import {
  finalFailureReason,
  VideoProcessingConsumer,
} from './video-processing.consumer';
import type { ProcessVideoJobData } from './video-processing.queue';
import type { VideoProcessingService } from './video-processing.service';

const job = (attemptsMade: number, attempts = 5): Job<ProcessVideoJobData> =>
  ({
    data: { videoId: 'video-id' },
    attemptsMade,
    opts: { attempts },
  }) as Job<ProcessVideoJobData>;

describe('VideoProcessingConsumer', () => {
  let processingService: { process: jest.Mock };
  let videosService: { markFailed: jest.Mock };
  let consumer: VideoProcessingConsumer;

  beforeEach(() => {
    processingService = { process: jest.fn().mockResolvedValue(undefined) };
    videosService = { markFailed: jest.fn().mockResolvedValue(true) };
    consumer = new VideoProcessingConsumer(
      processingService as unknown as VideoProcessingService,
      videosService as unknown as VideosService,
    );
  });

  describe('process', () => {
    it('should process the video of the job', async () => {
      await consumer.process(job(0));

      expect(processingService.process).toHaveBeenCalledWith('video-id');
    });

    it.each(['unsupported_format', 'invalid_media'] as const)(
      'should turn a permanent %s error into an UnrecoverableError with the reason',
      async (reason) => {
        processingService.process.mockRejectedValue(
          new PermanentProcessingError(reason, 'details'),
        );

        const error = await consumer.process(job(0)).catch((err) => err);

        expect(error).toBeInstanceOf(UnrecoverableError);
        expect((error as Error).message).toBe(reason);
      },
    );

    it('should rethrow other errors unchanged so BullMQ retries them', async () => {
      const transient = new Error('S3 unavailable');
      processingService.process.mockRejectedValue(transient);

      await expect(consumer.process(job(0))).rejects.toBe(transient);
    });
  });

  describe('finalFailureReason', () => {
    it('should keep retrying after an intermediate transient failure', () => {
      expect(finalFailureReason(job(2), new Error('timeout'))).toBeNull();
    });

    it('should settle processing_error on the last attempt', () => {
      expect(finalFailureReason(job(5), new Error('timeout'))).toBe(
        'processing_error',
      );
    });

    it.each(['unsupported_format', 'invalid_media'])(
      'should settle %s from an UnrecoverableError on the first attempt',
      (reason) => {
        expect(finalFailureReason(job(1), new UnrecoverableError(reason))).toBe(
          reason,
        );
      },
    );

    it('should settle processing_error for an UnrecoverableError with an unknown reason', () => {
      expect(
        finalFailureReason(job(1), new UnrecoverableError('something else')),
      ).toBe('processing_error');
    });

    it('should settle processing_error for a job stalled beyond the limit', () => {
      expect(
        finalFailureReason(
          job(1),
          new Error('job stalled more than allowable limit'),
        ),
      ).toBe('processing_error');
    });
  });

  describe('onFailed', () => {
    it('should not touch the video while retries remain', async () => {
      await consumer.onFailed(job(2), new Error('timeout'));

      expect(videosService.markFailed).not.toHaveBeenCalled();
    });

    it('should mark the video failed from processing with the settled reason', async () => {
      await consumer.onFailed(job(1), new UnrecoverableError('invalid_media'));

      expect(videosService.markFailed).toHaveBeenCalledWith(
        'video-id',
        'invalid_media',
        VideoStatus.Processing,
      );
    });

    it('should mark processing_error once attempts are exhausted', async () => {
      await consumer.onFailed(job(5), new Error('timeout'));

      expect(videosService.markFailed).toHaveBeenCalledWith(
        'video-id',
        'processing_error',
        VideoStatus.Processing,
      );
    });

    it('should ignore an event without a job', async () => {
      await consumer.onFailed(undefined, new Error('boom'));

      expect(videosService.markFailed).not.toHaveBeenCalled();
    });

    it('should not throw when marking the video failed fails', async () => {
      videosService.markFailed.mockRejectedValue(new Error('db down'));

      await expect(
        consumer.onFailed(job(5), new Error('timeout')),
      ).resolves.toBeUndefined();
    });
  });
});
