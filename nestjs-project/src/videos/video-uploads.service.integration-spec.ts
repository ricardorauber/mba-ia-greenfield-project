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
import { VideoUploadsService } from './video-uploads.service';
import { videoOriginalKey, videoPrefix } from './video-storage-keys';
import { VideosModule } from './videos.module';

describe('VideoUploadsService (integration, Postgres + MinIO)', () => {
  jest.setTimeout(30000);

  let module: TestingModule;
  let dataSource: DataSource;
  let uploads: VideoUploadsService;
  let storage: StorageService;
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
    uploads = module.get(VideoUploadsService);
    storage = module.get(StorageService);
  });

  afterAll(async () => {
    for (const id of createdVideoIds) {
      const video = await dataSource.getRepository(Video).findOneBy({ id });
      if (video) {
        await storage.abortMultipartUpload(
          videoOriginalKey(id),
          video.upload_id,
        );
      }
      await storage.deletePrefix(videoPrefix(id));
    }
    await cleanAllTables(dataSource);
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function createChannelOwner(): Promise<{
    user: User;
    channel: Channel;
  }> {
    const user = await dataSource.getRepository(User).save({
      email: 'uploads_it@example.com',
      password: 'hashed',
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: 'Uploads IT',
      nickname: 'uploads-it',
      user_id: user.id,
    });
    return { user, channel };
  }

  it('should persist the draft and open a real multipart upload in MinIO', async () => {
    const { user, channel } = await createChannelOwner();

    const { video, upload } = await uploads.initiate(user.id, {
      file_name: 'clip.mp4',
      mime_type: 'video/mp4',
      size: 1048576,
    });
    createdVideoIds.push(video.id);

    const row = await dataSource.getRepository(Video).findOneByOrFail({
      id: video.id,
    });
    expect(row).toMatchObject({
      channel_id: channel.id,
      status: VideoStatus.Draft,
      title: 'clip',
    });
    expect(row.upload_id).toEqual(expect.any(String));
    expect(upload).toEqual({ part_size: 67108864, part_count: 1 });
    // `null` would mean the multipart upload does not exist
    await expect(
      storage.listParts(videoOriginalKey(video.id), row.upload_id),
    ).resolves.toEqual([]);
  });
});
