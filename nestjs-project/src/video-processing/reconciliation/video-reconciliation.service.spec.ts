import type { StorageService } from '../../storage/storage.service';
import { type Video, VideoStatus } from '../../videos/entities/video.entity';
import type { VideosService } from '../../videos/videos.service';
import type { VideoProcessingProducer } from '../video-processing.producer';
import { VideoReconciliationService } from './video-reconciliation.service';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

const draft = (id: string): Video =>
  ({ id, status: VideoStatus.Draft, upload_id: `upload-${id}` }) as Video;
const processing = (id: string): Video =>
  ({ id, status: VideoStatus.Processing }) as Video;

describe('VideoReconciliationService', () => {
  let videosService: {
    findAbandonedDrafts: jest.Mock;
    findStuckProcessing: jest.Mock;
    markFailed: jest.Mock;
  };
  let storageService: { abortMultipartUpload: jest.Mock };
  let producer: { enqueue: jest.Mock };
  let service: VideoReconciliationService;

  beforeEach(() => {
    videosService = {
      findAbandonedDrafts: jest.fn().mockResolvedValue([]),
      findStuckProcessing: jest.fn().mockResolvedValue([]),
      markFailed: jest.fn().mockResolvedValue(true),
    };
    storageService = {
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    };
    producer = { enqueue: jest.fn().mockResolvedValue(undefined) };
    service = new VideoReconciliationService(
      videosService as unknown as VideosService,
      storageService as unknown as StorageService,
      producer as unknown as VideoProcessingProducer,
    );
  });

  it('should derive both thresholds and the batch limit from the injected now', async () => {
    await service.run(NOW);

    expect(videosService.findAbandonedDrafts).toHaveBeenCalledWith(
      new Date(NOW.getTime() - 24 * HOUR_MS),
      100,
    );
    expect(videosService.findStuckProcessing).toHaveBeenCalledWith(
      new Date(NOW.getTime() - HOUR_MS),
      100,
    );
  });

  it('should abort the upload of each abandoned draft and fail it from draft', async () => {
    videosService.findAbandonedDrafts.mockResolvedValue([draft('a')]);

    await service.run(NOW);

    expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
      'videos/a/original',
      'upload-a',
    );
    expect(videosService.markFailed).toHaveBeenCalledWith(
      'a',
      'upload_abandoned',
      VideoStatus.Draft,
    );
  });

  it('should keep a draft whose abort fails for the next run and go on with the rest', async () => {
    videosService.findAbandonedDrafts.mockResolvedValue([
      draft('a'),
      draft('b'),
    ]);
    storageService.abortMultipartUpload
      .mockRejectedValueOnce(new Error('S3 unavailable'))
      .mockResolvedValueOnce(undefined);

    const result = await service.run(NOW);

    expect(videosService.markFailed).toHaveBeenCalledTimes(1);
    expect(videosService.markFailed).toHaveBeenCalledWith(
      'b',
      'upload_abandoned',
      VideoStatus.Draft,
    );
    expect(result.abandoned).toBe(1);
  });

  it('should not count a draft whose conditional update lost the race', async () => {
    videosService.findAbandonedDrafts.mockResolvedValue([
      draft('a'),
      draft('b'),
    ]);
    videosService.markFailed
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const result = await service.run(NOW);

    expect(result.abandoned).toBe(1);
  });

  it('should re-enqueue every stuck video and report the counts', async () => {
    videosService.findAbandonedDrafts.mockResolvedValue([draft('a')]);
    videosService.findStuckProcessing.mockResolvedValue([
      processing('p1'),
      processing('p2'),
    ]);

    const result = await service.run(NOW);

    expect(producer.enqueue).toHaveBeenCalledWith('p1');
    expect(producer.enqueue).toHaveBeenCalledWith('p2');
    expect(result).toEqual({ abandoned: 1, requeued: 2 });
  });

  it('should default now to the current time', async () => {
    const before = Date.now();

    await service.run();

    const threshold = videosService.findStuckProcessing.mock
      .calls[0][0] as Date;
    expect(threshold.getTime()).toBeGreaterThanOrEqual(before - HOUR_MS);
    expect(threshold.getTime()).toBeLessThanOrEqual(Date.now() - HOUR_MS);
  });
});
