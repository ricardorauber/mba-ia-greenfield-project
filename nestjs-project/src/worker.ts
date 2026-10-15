import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  // Application context only: the worker serves no HTTP requests
  const app = await NestFactory.createApplicationContext(WorkerModule);
  // SIGTERM (docker compose stop) closes the BullMQ workers and connections
  app.enableShutdownHooks();
  Logger.log('Video worker ready, consuming video-processing', 'Worker');
}
void bootstrap();
