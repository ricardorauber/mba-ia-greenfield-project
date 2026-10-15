import { Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { configModuleOptions } from './config/config-module.options';
import { DatabaseModule } from './database/database.module';
import { QueueModule } from './queue/queue.module';
import { UsersModule } from './users/users.module';
import { VideoProcessingWorkerModule } from './video-processing/video-processing-worker.module';

/** Root of the `video-worker` process: no HTTP server, only queue consumers. */
@Module({
  imports: [
    ConfigModule.forRoot(configModuleOptions),
    DatabaseModule,
    QueueModule,
    // Registers the User entity: Channel#user (loaded through VideosModule)
    // cannot be resolved without it, as in AppModule via AuthModule
    UsersModule,
    VideoProcessingWorkerModule,
  ],
})
export class WorkerModule implements OnApplicationShutdown {
  // Makes a graceful stop (SIGTERM → workers and connections closed) visible
  // in `docker compose logs video-worker`
  onApplicationShutdown(signal?: string): void {
    Logger.log(`Video worker shut down (${signal ?? 'close'})`, 'Worker');
  }
}
