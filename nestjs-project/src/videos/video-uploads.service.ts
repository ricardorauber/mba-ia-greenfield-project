import { randomUUID } from 'crypto';
import { extname } from 'path';
import { Injectable, Logger } from '@nestjs/common';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import type { CreateVideoDto } from './dto/create-video.dto';
import type { Video } from './entities/video.entity';
import {
  ChannelNotFoundException,
  UnsupportedVideoFormatException,
  VideoTooLargeException,
} from './exceptions/video.exceptions';
import { videoOriginalKey } from './video-storage-keys';
import {
  ALLOWED_VIDEO_TYPES,
  MAX_VIDEO_SIZE_BYTES,
  MAX_VIDEO_TITLE_LENGTH,
  UPLOAD_PART_SIZE_BYTES,
} from './videos.constants';
import { VideosService } from './videos.service';

export interface UploadPlan {
  part_size: number;
  part_count: number;
}

export interface InitiatedUpload {
  video: Video;
  upload: UploadPlan;
}

/** Upload flow: the API only coordinates; the bytes go straight to storage. */
@Injectable()
export class VideoUploadsService {
  private readonly logger = new Logger(VideoUploadsService.name);

  constructor(
    private readonly videosService: VideosService,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
  ) {}

  async initiate(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<InitiatedUpload> {
    const extension = extname(dto.file_name);
    const expectedExtension = ALLOWED_VIDEO_TYPES[dto.mime_type];
    if (!expectedExtension || extension.toLowerCase() !== expectedExtension) {
      throw new UnsupportedVideoFormatException();
    }
    if (dto.size > MAX_VIDEO_SIZE_BYTES) {
      throw new VideoTooLargeException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new ChannelNotFoundException();
    }

    // The id is part of the object key, so it exists before the row does
    const id = randomUUID();
    const key = videoOriginalKey(id);
    const uploadId = await this.storageService.createMultipartUpload(
      key,
      dto.mime_type,
    );

    let video: Video;
    try {
      video = await this.videosService.createDraft({
        id,
        channelId: channel.id,
        title:
          dto.title ??
          dto.file_name
            .slice(0, dto.file_name.length - extension.length)
            .slice(0, MAX_VIDEO_TITLE_LENGTH),
        originalFilename: dto.file_name,
        mimeType: dto.mime_type,
        declaredSize: dto.size,
        uploadId,
      });
    } catch (err) {
      await this.abortQuietly(key, uploadId);
      throw err;
    }

    return { video, upload: this.uploadPlan(dto.size) };
  }

  private uploadPlan(declaredSize: number): UploadPlan {
    return {
      part_size: UPLOAD_PART_SIZE_BYTES,
      part_count: Math.ceil(declaredSize / UPLOAD_PART_SIZE_BYTES),
    };
  }

  // Best-effort cleanup: the caller still gets the original error, and the
  // reconciliation sweep is the safety net for anything left behind.
  private async abortQuietly(key: string, uploadId: string): Promise<void> {
    try {
      await this.storageService.abortMultipartUpload(key, uploadId);
    } catch (abortErr) {
      this.logger.warn(
        `Failed to abort multipart upload ${uploadId} for ${key}: ${String(abortErr)}`,
      );
    }
  }
}
