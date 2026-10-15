import { randomBytes, randomUUID } from 'crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { configModuleOptions } from '../config/config-module.options';
import { DatabaseModule } from '../database/database.module';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoDeliveryService } from './video-delivery.service';
import {
  videoOriginalKey,
  videoPrefix,
  videoThumbnailKey,
} from './video-storage-keys';
import { VideosModule } from './videos.module';

const ORIGINAL_SIZE = 4096;
// SOI + EOI markers: enough for storage to serve it as a JPEG object
const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

describe('VideoDeliveryService (integration, Postgres + MinIO)', () => {
  jest.setTimeout(30000);

  let module: TestingModule;
  let dataSource: DataSource;
  let delivery: VideoDeliveryService;
  let storage: StorageService;
  let user: User;
  let videoId: string;
  const original = randomBytes(ORIGINAL_SIZE);
  const createdVideoIds: string[] = [];

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot(configModuleOptions),
        DatabaseModule,
        // Channel#user needs User metadata; in AppModule UsersModule registers it
        TypeOrmModule.forFeature([User]),
        VideosModule,
      ],
    }).compile();
    dataSource = module.get(DataSource);
    delivery = module.get(VideoDeliveryService);
    storage = module.get(StorageService);
  });

  afterAll(async () => {
    for (const id of createdVideoIds) {
      await storage?.deletePrefix(videoPrefix(id));
    }
    if (dataSource) {
      await cleanAllTables(dataSource);
    }
    await module?.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    user = await dataSource.getRepository(User).save({
      email: 'delivery_it@example.com',
      password: 'hashed',
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: 'Delivery IT',
      nickname: 'delivery-it',
      user_id: user.id,
    });

    videoId = randomUUID();
    createdVideoIds.push(videoId);
    await storage.putObject(videoOriginalKey(videoId), original, 'video/mp4');
    await storage.putObject(
      videoThumbnailKey(videoId),
      TINY_JPEG,
      'image/jpeg',
    );
    await dataSource.getRepository(Video).insert({
      id: videoId,
      channel_id: channel.id,
      slug: randomUUID().slice(0, 11),
      title: 'Clip',
      original_filename: 'clip.mp4',
      mime_type: 'video/mp4',
      declared_size: ORIGINAL_SIZE,
      upload_id: 'completed-upload',
      status: VideoStatus.Ready,
      size: ORIGINAL_SIZE,
      has_thumbnail: true,
    });
  });

  it('should return a stream URL that serves byte ranges', async () => {
    const url = await delivery.getStreamUrl(user.id, videoId);

    const res = await fetch(url, { headers: { Range: 'bytes=0-1023' } });
    const body = Buffer.from(await res.arrayBuffer());

    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(
      `bytes 0-1023/${ORIGINAL_SIZE}`,
    );
    expect(body.equals(original.subarray(0, 1024))).toBe(true);
  });

  it('should return a download URL that responds as an attachment', async () => {
    const url = await delivery.getDownloadUrl(user.id, videoId);

    const res = await fetch(url);
    await res.arrayBuffer();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="clip.mp4"; filename*=UTF-8''clip.mp4`,
    );
  });

  it('should return a thumbnail URL that responds with image/jpeg', async () => {
    const url = await delivery.getThumbnailUrl(user.id, videoId);

    const res = await fetch(url);
    await res.arrayBuffer();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
  });
});
