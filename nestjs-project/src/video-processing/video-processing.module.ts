import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { VideosModule } from '../videos/videos.module';
import { MediaToolsService } from './media/media-tools.service';
import { VideoProcessingService } from './video-processing.service';

// Processing logic only; the queue consumer lives in the worker graph (TD-02)
@Module({
  imports: [VideosModule, StorageModule],
  providers: [MediaToolsService, VideoProcessingService],
  exports: [VideoProcessingService],
})
export class VideoProcessingModule {}
