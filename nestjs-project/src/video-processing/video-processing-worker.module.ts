import { Module } from '@nestjs/common';
import { VideosModule } from '../videos/videos.module';
import { VideoProcessingQueueModule } from './video-processing-queue.module';
import { VideoProcessingConsumer } from './video-processing.consumer';
import { VideoProcessingModule } from './video-processing.module';

// Consumer side: imported ONLY by WorkerModule so the API never consumes jobs (TD-02)
@Module({
  imports: [VideoProcessingModule, VideoProcessingQueueModule, VideosModule],
  providers: [VideoProcessingConsumer],
})
export class VideoProcessingWorkerModule {}
