import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { isPgUniqueViolationOnColumn } from '../database/pg-errors';
import {
  Video,
  type VideoFailureReason,
  type VideoMetadata,
  VideoStatus,
} from './entities/video.entity';
import { VideoNotFoundException } from './exceptions/video.exceptions';
import { generateVideoSlug } from './video-slug.util';

const SLUG_COLUMN = 'slug';
const MAX_SLUG_ATTEMPTS = 5;

export interface CreateDraftInput {
  id: string;
  channelId: string;
  title: string;
  originalFilename: string;
  mimeType: string;
  declaredSize: number;
  uploadId: string;
}

export interface VideoProcessingResult {
  duration: number;
  width: number;
  height: number;
  size: number;
  metadata: VideoMetadata;
  has_thumbnail: boolean;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
  ) {}

  /** Retries with a fresh slug when the random one collides (TD-14). */
  async createDraft(input: CreateDraftInput): Promise<Video> {
    for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt++) {
      try {
        await this.videoRepository.insert({
          id: input.id,
          channel_id: input.channelId,
          slug: generateVideoSlug(),
          title: input.title,
          original_filename: input.originalFilename,
          mime_type: input.mimeType,
          declared_size: input.declaredSize,
          upload_id: input.uploadId,
        });
        return await this.videoRepository.findOneByOrFail({ id: input.id });
      } catch (err) {
        if (!isPgUniqueViolationOnColumn(err, SLUG_COLUMN)) {
          throw err;
        }
      }
    }

    throw new Error(
      `Video slug collision could not be resolved after ${MAX_SLUG_ATTEMPTS} attempts`,
    );
  }

  /** Another channel's video is indistinguishable from a missing one (TD-15). */
  async findOwnedOrFail(userId: string, videoId: string): Promise<Video> {
    const video = await this.videoRepository
      .createQueryBuilder('video')
      .innerJoin('video.channel', 'channel')
      .where('video.id = :videoId', { videoId })
      .andWhere('channel.user_id = :userId', { userId })
      .getOne();
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  async findById(id: string): Promise<Video | null> {
    return this.videoRepository.findOneBy({ id });
  }

  // Transitions are conditional on the expected status: `false` means a
  // concurrent actor already moved the video (TD-10, TD-13).

  async markProcessing(id: string): Promise<boolean> {
    return this.transition(id, VideoStatus.Draft, {
      status: VideoStatus.Processing,
      processing_started_at: () => 'now()',
    });
  }

  async markReady(id: string, result: VideoProcessingResult): Promise<boolean> {
    return this.transition(id, VideoStatus.Processing, {
      status: VideoStatus.Ready,
      ...result,
    });
  }

  async markFailed(
    id: string,
    reason: VideoFailureReason,
    expectedStatus: VideoStatus,
  ): Promise<boolean> {
    return this.transition(id, expectedStatus, {
      status: VideoStatus.Failed,
      failure_reason: reason,
    });
  }

  async findAbandonedDrafts(
    createdBefore: Date,
    limit: number,
  ): Promise<Video[]> {
    return this.videoRepository.find({
      where: { status: VideoStatus.Draft, created_at: LessThan(createdBefore) },
      order: { created_at: 'ASC' },
      take: limit,
    });
  }

  async findStuckProcessing(
    startedBefore: Date,
    limit: number,
  ): Promise<Video[]> {
    return this.videoRepository.find({
      where: {
        status: VideoStatus.Processing,
        processing_started_at: LessThan(startedBefore),
      },
      order: { processing_started_at: 'ASC' },
      take: limit,
    });
  }

  private async transition(
    id: string,
    expected: VideoStatus,
    changes: Parameters<Repository<Video>['update']>[1],
  ): Promise<boolean> {
    const result = await this.videoRepository.update(
      { id, status: expected },
      changes,
    );
    return result.affected === 1;
  }
}
