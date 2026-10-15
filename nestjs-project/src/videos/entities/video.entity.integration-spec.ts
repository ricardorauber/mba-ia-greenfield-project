import { randomBytes, randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, type VideoMetadata, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const TEN_GIB = 10 * 1024 ** 3;

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const n = ++counter;
    const user = await dataSource.getRepository(User).save({
      email: `video_user_${n}@example.com`,
      password: 'hashed',
    });
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${n}`,
        nickname: `video-chan-${n}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(channelId: string, overrides: Partial<Video> = {}) {
    return videoRepository.create({
      id: randomUUID(),
      channel_id: channelId,
      slug: randomBytes(8).toString('base64url'),
      title: 'My video',
      original_filename: 'my-video.mp4',
      mime_type: 'video/mp4',
      declared_size: 1024,
      upload_id: 'upload-id',
      ...overrides,
    });
  }

  it('should apply defaults when only the required fields are set', async () => {
    const channel = await createChannel();
    const { id } = await videoRepository.save(buildVideo(channel.id));

    const video = await videoRepository.findOneByOrFail({ id });

    expect(video).toMatchObject({
      status: VideoStatus.Draft,
      has_thumbnail: false,
      duration: null,
      width: null,
      height: null,
      size: null,
      metadata: null,
      failure_reason: null,
      processing_started_at: null,
    });
    expect(video.created_at).toBeInstanceOf(Date);
    expect(video.updated_at).toBeInstanceOf(Date);
  });

  it('should reject a duplicate slug', async () => {
    const channel = await createChannel();
    await videoRepository.save(buildVideo(channel.id, { slug: 'dupSlug0001' }));

    await expect(
      videoRepository.save(buildVideo(channel.id, { slug: 'dupSlug0001' })),
    ).rejects.toThrow(/duplicate key value violates unique constraint/);
  });

  it('should delete the videos of a channel when the channel is removed', async () => {
    const channel = await createChannel();
    const { id } = await videoRepository.save(buildVideo(channel.id));

    await channelRepository.delete({ id: channel.id });

    await expect(videoRepository.findOneBy({ id })).resolves.toBeNull();
  });

  it('should read bigint sizes back as numbers', async () => {
    const channel = await createChannel();
    const { id } = await videoRepository.save(
      buildVideo(channel.id, { declared_size: TEN_GIB, size: TEN_GIB }),
    );

    const video = await videoRepository.findOneByOrFail({ id });

    expect(video.declared_size).toBe(10737418240);
    expect(video.size).toBe(10737418240);
  });

  it('should read the numeric duration back as a number', async () => {
    const channel = await createChannel();
    const { id } = await videoRepository.save(
      buildVideo(channel.id, { duration: 125.375 }),
    );

    const video = await videoRepository.findOneByOrFail({ id });

    expect(video.duration).toBe(125.375);
  });

  it('should round-trip the jsonb metadata', async () => {
    const channel = await createChannel();
    const metadata: VideoMetadata = {
      video_codec: 'h264',
      audio_codec: null,
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      bit_rate: 1500000,
      frame_rate: 29.97,
    };
    const { id } = await videoRepository.save(
      buildVideo(channel.id, { metadata }),
    );

    const video = await videoRepository.findOneByOrFail({ id });

    expect(video.metadata).toEqual(metadata);
  });

  it('should reject a status outside the enum', async () => {
    const channel = await createChannel();

    await expect(
      videoRepository.save(
        buildVideo(channel.id, { status: 'archived' as VideoStatus }),
      ),
    ).rejects.toThrow(/invalid input value for enum videos_status_enum/);
  });
});
