import { Injectable, Logger } from '@nestjs/common';
import { StorageService } from '../storage/storage.service';
import { VideoStatus } from '../videos/entities/video.entity';
import {
  videoOriginalKey,
  videoThumbnailKey,
} from '../videos/video-storage-keys';
import { VideosService } from '../videos/videos.service';
import { MediaToolError } from './media/media-tool-error';
import { MediaToolsService } from './media/media-tools.service';
import { assertPlayable } from './playback-allowlist';
import { PermanentProcessingError } from './video-processing-errors';

const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';
// Frame at 10% of the duration; clips shorter than 1 s use the first frame
const THUMBNAIL_POSITION_RATIO = 0.1;
const SHORT_CLIP_SECONDS = 1;

/**
 * Turns an uploaded original into a `ready` video: validates it is playable,
 * extracts its metadata and stores a thumbnail. Queue-agnostic; safe to run
 * more than once for the same video (at-least-once delivery, TD-13).
 *
 * Throws `PermanentProcessingError` when retrying cannot help; any other error
 * (storage, transient ffmpeg failures) propagates unchanged so it is retried.
 */
@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    private readonly videosService: VideosService,
    private readonly storageService: StorageService,
    private readonly mediaTools: MediaToolsService,
  ) {}

  async process(videoId: string): Promise<void> {
    const video = await this.videosService.findById(videoId);
    if (!video || video.status !== VideoStatus.Processing) {
      this.logger.log(
        `Skipping video ${videoId}: ${video ? `status is ${video.status}` : 'not found'}`,
      );
      return;
    }

    const originalKey = videoOriginalKey(videoId);
    // ffprobe/ffmpeg read the original by range through the internal endpoint
    const sourceUrl = await this.storageService.presignInternalGet(originalKey);

    const probe = await this.asPermanent(this.mediaTools.probe(sourceUrl));
    assertPlayable(video.mime_type, probe);
    // A ready video always has a duration
    if (probe.duration === null) {
      throw new PermanentProcessingError(
        'invalid_media',
        'Neither the container nor the video stream declares a duration',
      );
    }
    const duration = probe.duration;

    const thumbnailAt =
      duration < SHORT_CLIP_SECONDS ? 0 : duration * THUMBNAIL_POSITION_RATIO;
    const jpeg = await this.asPermanent(
      this.mediaTools.extractFrame(sourceUrl, thumbnailAt),
    );
    await this.storageService.putObject(
      videoThumbnailKey(videoId),
      jpeg,
      THUMBNAIL_CONTENT_TYPE,
    );

    const stored = await this.storageService.headObject(originalKey);
    if (!stored) {
      // Not classified as permanent: the retry budget decides
      throw new Error(`Original of video ${videoId} is missing from storage`);
    }

    const updated = await this.videosService.markReady(videoId, {
      duration,
      width: probe.width,
      height: probe.height,
      size: stored.contentLength,
      metadata: {
        video_codec: probe.video_codec,
        audio_codec: probe.audio_codec,
        format_name: probe.format_name,
        bit_rate: probe.bit_rate,
        frame_rate: probe.frame_rate,
      },
      has_thumbnail: true,
    });
    if (!updated) {
      this.logger.warn(
        `Video ${videoId} left processing while being processed; not marked ready`,
      );
    }
  }

  // Broken media is permanent; transient media-tool failures stay retryable
  private async asPermanent<T>(operation: Promise<T>): Promise<T> {
    try {
      return await operation;
    } catch (err) {
      if (err instanceof MediaToolError && err.kind === 'invalid_media') {
        throw new PermanentProcessingError('invalid_media', err.message, {
          cause: err,
        });
      }
      throw err;
    }
  }
}
