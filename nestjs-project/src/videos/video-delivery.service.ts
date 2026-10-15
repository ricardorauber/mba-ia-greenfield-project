import { Injectable } from '@nestjs/common';
import { StorageService } from '../storage/storage.service';
import { buildAttachmentDisposition } from './content-disposition.util';
import { type Video, VideoStatus } from './entities/video.entity';
import { VideoNotReadyException } from './exceptions/video.exceptions';
import { videoOriginalKey, videoThumbnailKey } from './video-storage-keys';
import { VideosService } from './videos.service';

/**
 * Short-lived presigned URLs (public endpoint) for the owner to stream,
 * download or see the thumbnail of a ready video; the bytes never go through
 * the API, and storage serves `Range`/`206` natively (TD-15).
 */
@Injectable()
export class VideoDeliveryService {
  constructor(
    private readonly videosService: VideosService,
    private readonly storageService: StorageService,
  ) {}

  async getStreamUrl(userId: string, id: string): Promise<string> {
    await this.findOwnedReadyOrFail(userId, id);
    const { url } = await this.storageService.presignGet(videoOriginalKey(id));
    return url;
  }

  async getDownloadUrl(userId: string, id: string): Promise<string> {
    const video = await this.findOwnedReadyOrFail(userId, id);
    const { url } = await this.storageService.presignGet(videoOriginalKey(id), {
      responseContentDisposition: buildAttachmentDisposition(
        video.original_filename,
      ),
    });
    return url;
  }

  async getThumbnailUrl(userId: string, id: string): Promise<string> {
    const video = await this.findOwnedReadyOrFail(userId, id);
    if (!video.has_thumbnail) {
      throw new VideoNotReadyException();
    }
    const { url } = await this.storageService.presignGet(videoThumbnailKey(id));
    return url;
  }

  // Ownership first: a non-owner always gets 404, never 409 (TD-15)
  private async findOwnedReadyOrFail(
    userId: string,
    id: string,
  ): Promise<Video> {
    const video = await this.videosService.findOwnedOrFail(userId, id);
    if (video.status !== VideoStatus.Ready) {
      throw new VideoNotReadyException();
    }
    return video;
  }
}
