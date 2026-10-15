import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { VideoProcessingProducer } from './video-processing.producer';
import { VIDEO_PROCESSING_QUEUE } from './video-processing.queue';

// Producer side only: consumers live exclusively in the worker's module graph
@Module({
  imports: [
    QueueModule,
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
  ],
  providers: [VideoProcessingProducer],
  exports: [VideoProcessingProducer],
})
export class VideoProcessingQueueModule {}
