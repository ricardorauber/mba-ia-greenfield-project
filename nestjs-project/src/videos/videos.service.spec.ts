import { QueryFailedError, type Repository } from 'typeorm';
import { Video } from './entities/video.entity';
import { generateVideoSlug } from './video-slug.util';
import { type CreateDraftInput, VideosService } from './videos.service';

jest.mock('./video-slug.util', () => ({
  generateVideoSlug: jest.fn(),
}));

const mockGenerateVideoSlug = generateVideoSlug as jest.MockedFunction<
  typeof generateVideoSlug
>;

function makeUniqueError(column: string): QueryFailedError {
  const err = new QueryFailedError('INSERT', [], new Error()) as any;
  err.code = '23505';
  err.detail = `Key (${column})=(value) already exists.`;
  return err;
}

const input: CreateDraftInput = {
  id: '6f1c1d2e-0b7a-4c55-9a3e-1f2d3c4b5a69',
  channelId: '0b5e6f7a-8c9d-4e1f-a2b3-c4d5e6f7a8b9',
  title: 'My video',
  originalFilename: 'my-video.mp4',
  mimeType: 'video/mp4',
  declaredSize: 1024,
  uploadId: 'upload-id',
};

describe('VideosService', () => {
  let repository: { insert: jest.Mock; findOneByOrFail: jest.Mock };
  let service: VideosService;
  const persisted = { id: input.id } as Video;

  beforeEach(() => {
    let counter = 0;
    mockGenerateVideoSlug.mockReset();
    mockGenerateVideoSlug.mockImplementation(() => `slug-${++counter}`);
    repository = {
      insert: jest.fn(),
      findOneByOrFail: jest.fn().mockResolvedValue(persisted),
    };
    service = new VideosService(repository as unknown as Repository<Video>);
  });

  describe('createDraft', () => {
    it('should retry with a new slug when the slug is already taken', async () => {
      repository.insert
        .mockRejectedValueOnce(makeUniqueError('slug'))
        .mockResolvedValueOnce(undefined);

      const result = await service.createDraft(input);

      expect(result).toBe(persisted);
      expect(repository.insert).toHaveBeenCalledTimes(2);
      expect(repository.insert.mock.calls[0][0].slug).toBe('slug-1');
      expect(repository.insert.mock.calls[1][0].slug).toBe('slug-2');
    });

    it('should rethrow a unique violation on another column without retrying', async () => {
      const error = makeUniqueError('id');
      repository.insert.mockRejectedValueOnce(error);

      await expect(service.createDraft(input)).rejects.toBe(error);
      expect(repository.insert).toHaveBeenCalledTimes(1);
    });

    it('should give up after 5 slug collisions', async () => {
      repository.insert.mockRejectedValue(makeUniqueError('slug'));

      await expect(service.createDraft(input)).rejects.toThrow(
        /after 5 attempts/,
      );
      expect(repository.insert).toHaveBeenCalledTimes(5);
      expect(repository.findOneByOrFail).not.toHaveBeenCalled();
    });
  });
});
