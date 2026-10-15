import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { VideosModule } from '../videos/videos.module';
import { VideoReconciliationConsumer } from './reconciliation/video-reconciliation.consumer';
import { VideoReconciliationScheduler } from './reconciliation/video-reconciliation.scheduler';
import { VideoReconciliationService } from './reconciliation/video-reconciliation.service';
import { VideoProcessingQueueModule } from './video-processing-queue.module';
import { VideoProcessingConsumer } from './video-processing.consumer';
import { VideoProcessingModule } from './video-processing.module';
import { VIDEO_RECONCILIATION_QUEUE } from './video-processing.queue';

// Consumer side: imported ONLY by WorkerModule so the API never consumes jobs (TD-02)
@Module({
  imports: [
    VideoProcessingModule,
    VideoProcessingQueueModule,
    VideosModule,
    StorageModule,
    BullModule.registerQueue({ name: VIDEO_RECONCILIATION_QUEUE }),
  ],
  providers: [
    VideoProcessingConsumer,
    VideoReconciliationService,
    VideoReconciliationConsumer,
    VideoReconciliationScheduler,
  ],
})
export class VideoProcessingWorkerModule {}
