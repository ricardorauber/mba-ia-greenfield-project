import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, type Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { configModuleOptions } from '../config/config-module.options';
import { DatabaseModule } from '../database/database.module';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import {
  createVideoFixtures,
  type VideoFixtures,
} from '../test/video-fixtures';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import {
  videoOriginalKey,
  videoPrefix,
  videoThumbnailKey,
} from '../videos/video-storage-keys';
import { MediaToolsService } from './media/media-tools.service';
import { PermanentProcessingError } from './video-processing-errors';
import { VideoProcessingModule } from './video-processing.module';
import { VideoProcessingService } from './video-processing.service';

describe('VideoProcessingService (integration, Postgres + MinIO + FFmpeg)', () => {
  jest.setTimeout(120_000);

  let fixtures: VideoFixtures;
  let module: TestingModule;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let processing: VideoProcessingService;
  let storage: StorageService;
  let media: MediaToolsService;
  let channel: Channel;
  const createdVideoIds: string[] = [];

  beforeAll(async () => {
    fixtures = await createVideoFixtures();
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot(configModuleOptions),
        DatabaseModule,
        // Channel#user needs User metadata; in AppModule UsersModule registers it
        TypeOrmModule.forFeature([User]),
        VideoProcessingModule,
      ],
    }).compile();
    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    processing = module.get(VideoProcessingService);
    storage = module.get(StorageService);
    media = module.get(MediaToolsService);
  });

  afterAll(async () => {
    for (const id of createdVideoIds) {
      await storage?.deletePrefix(videoPrefix(id));
    }
    if (dataSource) {
      await cleanAllTables(dataSource);
    }
    await module?.close();
    await fixtures?.cleanup();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save({
      email: 'processing_it@example.com',
      password: 'hashed',
    });
    channel = await dataSource.getRepository(Channel).save({
      name: 'Processing IT',
      nickname: 'processing-it',
      user_id: user.id,
    });
  });

  /** A `processing` row whose original is the given fixture file. */
  async function processingVideo(
    file: string,
    mimeType: string,
  ): Promise<string> {
    const id = randomUUID();
    createdVideoIds.push(id);
    const bytes = await readFile(file);
    await storage.putObject(videoOriginalKey(id), bytes, mimeType);
    await videoRepository.insert({
      id,
      channel_id: channel.id,
      slug: randomUUID().slice(0, 11),
      title: 'Fixture',
      original_filename: `fixture${mimeType === 'video/webm' ? '.webm' : '.mp4'}`,
      mime_type: mimeType,
      declared_size: bytes.length,
      upload_id: 'completed-upload',
      status: VideoStatus.Processing,
      processing_started_at: () => 'now()',
    });
    return id;
  }

  // Presigned URLs are signed for GET only (HEAD gets 403): read headers
  // through a 1-byte ranged GET instead
  async function objectHeaders(key: string): Promise<Response> {
    const url = await storage.presignInternalGet(key);
    const res = await fetch(url, { headers: { Range: 'bytes=0-0' } });
    await res.arrayBuffer();
    return res;
  }

  async function processError(id: string): Promise<PermanentProcessingError> {
    try {
      await processing.process(id);
    } catch (err) {
      return err as PermanentProcessingError;
    }
    throw new Error('Expected processing to fail');
  }

  it('should mark an H.264/AAC MP4 ready with its metadata and a JPEG thumbnail', async () => {
    const id = await processingVideo(fixtures.mp4, 'video/mp4');

    await processing.process(id);

    const row = await videoRepository.findOneByOrFail({ id });
    const stored = await storage.headObject(videoOriginalKey(id));
    expect(row.status).toBe(VideoStatus.Ready);
    expect(row.duration).toBeCloseTo(3, 0);
    expect(row).toMatchObject({
      width: 320,
      height: 240,
      size: stored!.contentLength,
      has_thumbnail: true,
      metadata: {
        video_codec: 'h264',
        audio_codec: 'aac',
        format_name: expect.stringContaining('mp4'),
        bit_rate: expect.any(Number),
        frame_rate: 25,
      },
    });

    const thumbnailHead = await objectHeaders(videoThumbnailKey(id));
    expect(thumbnailHead.status).toBe(206);
    expect(thumbnailHead.headers.get('content-type')).toBe('image/jpeg');
    const thumbnail = await media.probe(
      await storage.presignInternalGet(videoThumbnailKey(id)),
    );
    expect(thumbnail.width).toBeLessThanOrEqual(1280);
  });

  it('should mark a VP9/Opus WebM ready', async () => {
    const id = await processingVideo(fixtures.webm, 'video/webm');

    await processing.process(id);

    const row = await videoRepository.findOneByOrFail({ id });
    expect(row.status).toBe(VideoStatus.Ready);
    expect(row.duration).toBeGreaterThan(0);
    expect(row.metadata).toMatchObject({
      video_codec: 'vp9',
      audio_codec: 'opus',
    });
    await expect(
      storage.headObject(videoThumbnailKey(id)),
    ).resolves.not.toBeNull();
  });

  it('should scale the thumbnail of a 1920x1080 video to 1280 px wide', async () => {
    const id = await processingVideo(fixtures.mp4FullHd, 'video/mp4');

    await processing.process(id);

    const thumbnail = await media.probe(
      await storage.presignInternalGet(videoThumbnailKey(id)),
    );
    expect(thumbnail.width).toBe(1280);
  });

  it('should reject MPEG-4 Part 2 declared as video/mp4 without storing a thumbnail', async () => {
    const id = await processingVideo(fixtures.mp4Mpeg4Part2, 'video/mp4');

    const error = await processError(id);

    expect(error).toBeInstanceOf(PermanentProcessingError);
    expect(error.reason).toBe('unsupported_format');
    await expect(storage.headObject(videoThumbnailKey(id))).resolves.toBeNull();
    const row = await videoRepository.findOneByOrFail({ id });
    expect(row.status).toBe(VideoStatus.Processing);
  });

  it('should reject a WebM declared as video/mp4', async () => {
    const id = await processingVideo(fixtures.webm, 'video/mp4');

    const error = await processError(id);

    expect(error.reason).toBe('unsupported_format');
  });

  it('should fail a corrupt file with invalid_media', async () => {
    const id = await processingVideo(fixtures.mp4Corrupt, 'video/mp4');

    const error = await processError(id);

    expect(error).toBeInstanceOf(PermanentProcessingError);
    expect(error.reason).toBe('invalid_media');
  });

  it('should leave a ready video and its storage untouched when processed again', async () => {
    const id = await processingVideo(fixtures.mp4, 'video/mp4');
    await processing.process(id);
    const before = await videoRepository.findOneByOrFail({ id });
    const thumbnailBefore = await storage.headObject(videoThumbnailKey(id));
    const etagBefore = (await objectHeaders(videoThumbnailKey(id))).headers.get(
      'etag',
    );

    await processing.process(id);

    const after = await videoRepository.findOneByOrFail({ id });
    expect(after).toEqual(before);
    await expect(storage.headObject(videoThumbnailKey(id))).resolves.toEqual(
      thumbnailBefore,
    );
    expect(
      (await objectHeaders(videoThumbnailKey(id))).headers.get('etag'),
    ).toBe(etagBefore);
  });
});
