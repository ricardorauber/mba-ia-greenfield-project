import { randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoNotFoundException } from './exceptions/video.exceptions';
import { type CreateDraftInput, VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const HOUR_MS = 60 * 60 * 1000;

describe('VideosService (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let videosService: VideosService;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
    videosService = new VideosService(videoRepository);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createOwner(): Promise<{ user: User; channel: Channel }> {
    const n = ++counter;
    const user = await dataSource.getRepository(User).save({
      email: `videos_svc_${n}@example.com`,
      password: 'hashed',
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: `Channel ${n}`,
      nickname: `videos-svc-${n}`,
      user_id: user.id,
    });
    return { user, channel };
  }

  function draftInput(channelId: string): CreateDraftInput {
    return {
      id: randomUUID(),
      channelId,
      title: 'My video',
      originalFilename: 'my-video.mp4',
      mimeType: 'video/mp4',
      declaredSize: 2048,
      uploadId: 'upload-id',
    };
  }

  async function backdate(
    id: string,
    column: 'created_at' | 'processing_started_at',
    hoursAgo: number,
  ): Promise<void> {
    await dataSource.query(
      `UPDATE "videos" SET "${column}" = now() - ($2 || ' hours')::interval WHERE id = $1`,
      [id, String(hoursAgo)],
    );
  }

  describe('createDraft', () => {
    it('should persist a draft with a unique 11-character base64url slug', async () => {
      const { channel } = await createOwner();

      const first = await videosService.createDraft(draftInput(channel.id));
      const second = await videosService.createDraft(draftInput(channel.id));

      expect(first).toMatchObject({
        channel_id: channel.id,
        status: VideoStatus.Draft,
        declared_size: 2048,
        upload_id: 'upload-id',
      });
      expect(first.slug).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(second.slug).not.toBe(first.slug);
    });
  });

  describe('findOwnedOrFail', () => {
    it('should return the video to its owner', async () => {
      const { user, channel } = await createOwner();
      const { id } = await videosService.createDraft(draftInput(channel.id));

      const video = await videosService.findOwnedOrFail(user.id, id);

      expect(video.id).toBe(id);
    });

    it('should throw VideoNotFoundException for a video of another channel', async () => {
      const { channel } = await createOwner();
      const { user: stranger } = await createOwner();
      const { id } = await videosService.createDraft(draftInput(channel.id));

      await expect(
        videosService.findOwnedOrFail(stranger.id, id),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('should throw VideoNotFoundException for a missing video', async () => {
      const { user } = await createOwner();

      await expect(
        videosService.findOwnedOrFail(user.id, randomUUID()),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });

  describe('status transitions', () => {
    it('should move draft to processing once and record processing_started_at', async () => {
      const { channel } = await createOwner();
      const { id } = await videosService.createDraft(draftInput(channel.id));

      await expect(videosService.markProcessing(id)).resolves.toBe(true);
      await expect(videosService.markProcessing(id)).resolves.toBe(false);

      const video = await videosService.findById(id);
      expect(video!.status).toBe(VideoStatus.Processing);
      expect(video!.processing_started_at).toBeInstanceOf(Date);
    });

    it('should not fail a video expected in draft once it is processing', async () => {
      const { channel } = await createOwner();
      const { id } = await videosService.createDraft(draftInput(channel.id));
      await videosService.markProcessing(id);

      const changed = await videosService.markFailed(
        id,
        'upload_abandoned',
        VideoStatus.Draft,
      );

      expect(changed).toBe(false);
      const video = await videosService.findById(id);
      expect(video!.status).toBe(VideoStatus.Processing);
      expect(video!.failure_reason).toBeNull();
    });

    it('should mark a draft as failed with the reason', async () => {
      const { channel } = await createOwner();
      const { id } = await videosService.createDraft(draftInput(channel.id));

      await expect(
        videosService.markFailed(id, 'size_mismatch', VideoStatus.Draft),
      ).resolves.toBe(true);

      const video = await videosService.findById(id);
      expect(video).toMatchObject({
        status: VideoStatus.Failed,
        failure_reason: 'size_mismatch',
      });
    });

    it('should move processing to ready with the processing result, only from processing', async () => {
      const { channel } = await createOwner();
      const { id } = await videosService.createDraft(draftInput(channel.id));
      const result = {
        duration: 12.5,
        width: 1920,
        height: 1080,
        size: 2048,
        metadata: {
          video_codec: 'h264',
          audio_codec: 'aac',
          format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
          bit_rate: 800000,
          frame_rate: 30,
        },
        has_thumbnail: true,
      };

      await expect(videosService.markReady(id, result)).resolves.toBe(false);
      await videosService.markProcessing(id);
      await expect(videosService.markReady(id, result)).resolves.toBe(true);

      const video = await videosService.findById(id);
      expect(video).toMatchObject({ status: VideoStatus.Ready, ...result });
    });
  });

  describe('sweep finders', () => {
    it('should find only drafts created before the threshold', async () => {
      const { channel } = await createOwner();
      const old = await videosService.createDraft(draftInput(channel.id));
      const recent = await videosService.createDraft(draftInput(channel.id));
      const oldProcessing = await videosService.createDraft(
        draftInput(channel.id),
      );
      await videosService.markProcessing(oldProcessing.id);
      await backdate(old.id, 'created_at', 25);
      await backdate(oldProcessing.id, 'created_at', 25);

      const found = await videosService.findAbandonedDrafts(
        new Date(Date.now() - 24 * HOUR_MS),
        100,
      );

      expect(found.map((v) => v.id)).toEqual([old.id]);
      expect(found.map((v) => v.id)).not.toContain(recent.id);
    });

    it('should find only videos processing since before the threshold', async () => {
      const { channel } = await createOwner();
      const stuck = await videosService.createDraft(draftInput(channel.id));
      const fresh = await videosService.createDraft(draftInput(channel.id));
      await videosService.markProcessing(stuck.id);
      await videosService.markProcessing(fresh.id);
      await backdate(stuck.id, 'processing_started_at', 2);

      const found = await videosService.findStuckProcessing(
        new Date(Date.now() - HOUR_MS),
        100,
      );

      expect(found.map((v) => v.id)).toEqual([stuck.id]);
    });

    it('should honour the limit', async () => {
      const { channel } = await createOwner();
      for (let i = 0; i < 3; i++) {
        const { id } = await videosService.createDraft(draftInput(channel.id));
        await backdate(id, 'created_at', 25 + i);
      }

      const found = await videosService.findAbandonedDrafts(
        new Date(Date.now() - 24 * HOUR_MS),
        2,
      );

      expect(found).toHaveLength(2);
    });
  });
});
