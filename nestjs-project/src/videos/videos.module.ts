import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { StorageModule } from '../storage/storage.module';
import { VideoProcessingQueueModule } from '../video-processing/video-processing-queue.module';
import { Video } from './entities/video.entity';
import { VideoUploadsService } from './video-uploads.service';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    ChannelsModule,
    StorageModule,
    VideoProcessingQueueModule,
  ],
  controllers: [VideosController],
  providers: [VideosService, VideoUploadsService],
  exports: [VideosService],
})
export class VideosModule {}
