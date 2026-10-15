import { randomUUID } from 'crypto';
import { extname } from 'path';
import { Injectable, Logger } from '@nestjs/common';
import { ChannelsService } from '../channels/channels.service';
import type { UploadedPart } from '../storage/storage.service';
import { StorageService } from '../storage/storage.service';
import { VideoProcessingProducer } from '../video-processing/video-processing.producer';
import type { CreateVideoDto } from './dto/create-video.dto';
import { type Video, VideoStatus } from './entities/video.entity';
import {
  ChannelNotFoundException,
  InvalidPartNumberException,
  InvalidVideoStatusException,
  UnsupportedVideoFormatException,
  UploadIncompleteException,
  UploadSizeMismatchException,
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

export interface UploadedPartStatus {
  part_number: number;
  size: number;
}

export interface UploadStatus extends UploadPlan {
  uploaded_parts: UploadedPartStatus[];
}

export interface PartUrl {
  part_number: number;
  url: string;
}

export interface PartUrls {
  expires_in: number;
  parts: PartUrl[];
}

/** Upload flow: the API only coordinates; the bytes go straight to storage. */
@Injectable()
export class VideoUploadsService {
  private readonly logger = new Logger(VideoUploadsService.name);

  constructor(
    private readonly videosService: VideosService,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    private readonly processingProducer: VideoProcessingProducer,
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

  /** What is already in storage, so an interrupted upload can resume (TD-07). */
  async getUploadStatus(userId: string, id: string): Promise<UploadStatus> {
    const video = await this.findOwnedDraftOrFail(userId, id);

    // `null` = the multipart upload is gone, so nothing is stored yet
    const parts =
      (await this.storageService.listParts(
        videoOriginalKey(id),
        video.upload_id,
      )) ?? [];

    return {
      ...this.uploadPlan(video.declared_size),
      uploaded_parts: parts.map((part) => ({
        part_number: part.partNumber,
        size: part.size,
      })),
    };
  }

  /**
   * Presigned UploadPart URLs (public endpoint) for a batch of parts; the
   * client PUTs each part straight to storage (TD-05, TD-07).
   * `partNumbers` is non-empty: the DTO enforces 1..100 unique items.
   */
  async presignParts(
    userId: string,
    id: string,
    partNumbers: number[],
  ): Promise<PartUrls> {
    const video = await this.findOwnedDraftOrFail(userId, id);
    const { part_count } = this.uploadPlan(video.declared_size);
    if (partNumbers.some((partNumber) => partNumber > part_count)) {
      throw new InvalidPartNumberException();
    }

    const key = videoOriginalKey(id);
    const signed = await Promise.all(
      partNumbers.map((partNumber) =>
        this.storageService.presignUploadPart(key, video.upload_id, partNumber),
      ),
    );

    return {
      // Every URL of the batch is signed with the same configured TTL
      expires_in: signed[0].expiresIn,
      parts: signed.map(({ url }, index) => ({
        part_number: partNumbers[index],
        url,
      })),
    };
  }

  /**
   * Assembles the uploaded parts, checks the real size and hands the video to
   * the worker (TD-07, TD-08). Replays on `processing`/`ready` return the
   * current video without side effects.
   */
  async complete(userId: string, id: string): Promise<Video> {
    const video = await this.videosService.findOwnedOrFail(userId, id);
    if (
      video.status === VideoStatus.Processing ||
      video.status === VideoStatus.Ready
    ) {
      return video;
    }
    if (video.status !== VideoStatus.Draft) {
      throw new InvalidVideoStatusException();
    }

    const key = videoOriginalKey(id);
    const parts = await this.storageService.listParts(key, video.upload_id);
    // `null`: the multipart upload is gone, typically because an earlier call
    // completed it and failed before the status change; the object decides
    if (parts !== null) {
      this.assertAllPartsUploaded(parts, video.declared_size);
      await this.storageService.completeMultipartUpload(
        key,
        video.upload_id,
        parts,
      );
    }

    const stored = await this.storageService.headObject(key);
    if (!stored) {
      throw new UploadIncompleteException();
    }
    // The presigned part URLs cannot enforce sizes, so the assembled object
    // is the source of truth (TD-07)
    if (
      stored.contentLength !== video.declared_size ||
      stored.contentLength > MAX_VIDEO_SIZE_BYTES
    ) {
      await this.storageService.deleteObject(key);
      await this.videosService.markFailed(
        id,
        'size_mismatch',
        VideoStatus.Draft,
      );
      throw new UploadSizeMismatchException();
    }

    // `false`: the reconciliation sweep abandoned the draft in the meantime
    if (!(await this.videosService.markProcessing(id))) {
      throw new InvalidVideoStatusException();
    }

    try {
      await this.processingProducer.enqueue(id);
    } catch (err) {
      // The sweep re-enqueues videos stuck in processing (TD-13)
      this.logger.warn(
        `Failed to enqueue processing of video ${id}: ${String(err)}`,
      );
    }

    return this.videosService.findOwnedOrFail(userId, id);
  }

  // Parts must be exactly 1..part_count and add up to the declared size
  private assertAllPartsUploaded(
    parts: UploadedPart[],
    declaredSize: number,
  ): void {
    const { part_count } = this.uploadPlan(declaredSize);
    const contiguous =
      parts.length === part_count &&
      parts.every((part, index) => part.partNumber === index + 1);
    const totalSize = parts.reduce((sum, part) => sum + part.size, 0);
    if (!contiguous || totalSize !== declaredSize) {
      throw new UploadIncompleteException();
    }
  }

  // Ownership is checked first so non-owners always get 404, never 409
  private async findOwnedDraftOrFail(
    userId: string,
    id: string,
  ): Promise<Video> {
    const video = await this.videosService.findOwnedOrFail(userId, id);
    if (video.status !== VideoStatus.Draft) {
      throw new InvalidVideoStatusException();
    }
    return video;
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
