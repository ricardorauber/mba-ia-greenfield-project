import { randomBytes, randomUUID } from 'crypto';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { configModuleOptions } from '../config/config-module.options';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const MIB = 1024 * 1024;
// S3 requires every part except the last to be at least 5 MiB
const FIRST_PART_SIZE = 5 * MIB;
const LAST_PART_SIZE = 1000;

const putPart = async (url: string, body: Buffer): Promise<Response> =>
  fetch(url, { method: 'PUT', body: new Uint8Array(body) });

describe('StorageService (integration, MinIO)', () => {
  jest.setTimeout(30000);

  let module: TestingModule;
  let storage: StorageService;
  let config: ConfigType<typeof storageConfig>;
  const prefix = `storage-it/${randomUUID()}/`;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(configModuleOptions), StorageModule],
    }).compile();
    storage = module.get(StorageService);
    config = module.get(storageConfig.KEY);
  });

  afterAll(async () => {
    await storage.deletePrefix(prefix);
    await module.close();
  });

  describe('multipart upload through presigned part URLs', () => {
    const key = `${prefix}multipart/original`;
    const firstPart = randomBytes(FIRST_PART_SIZE);
    const lastPart = randomBytes(LAST_PART_SIZE);
    let uploadId: string;
    const etags: Record<number, string> = {};

    beforeAll(async () => {
      uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    });

    it('should sign part URLs for the public endpoint with the configured TTL and no checksum params', async () => {
      const { url, expiresIn } = await storage.presignUploadPart(
        key,
        uploadId,
        1,
      );
      const params = new URL(url).searchParams;

      expect(url.startsWith(config.publicEndpoint!)).toBe(true);
      expect(expiresIn).toBe(config.uploadPartUrlTtlSeconds);
      expect(params.get('X-Amz-Expires')).toBe(
        String(config.uploadPartUrlTtlSeconds),
      );
      expect(url).not.toMatch(/x-amz-checksum-crc32/i);
      expect(url).not.toMatch(/x-amz-sdk-checksum-algorithm/i);
    });

    it('should accept PUT of each part and answer 200 with an ETag', async () => {
      for (const [partNumber, body] of [
        [1, firstPart],
        [2, lastPart],
      ] as const) {
        const { url } = await storage.presignUploadPart(
          key,
          uploadId,
          partNumber,
        );

        const response = await putPart(url, body);

        expect(response.status).toBe(200);
        const etag = response.headers.get('etag');
        expect(etag).toBeTruthy();
        etags[partNumber] = etag!;
      }
    });

    it('should list the uploaded parts in ascending order with sizes and ETags', async () => {
      const parts = await storage.listParts(key, uploadId);

      expect(parts).toEqual([
        { partNumber: 1, size: FIRST_PART_SIZE, etag: etags[1] },
        { partNumber: 2, size: LAST_PART_SIZE, etag: etags[2] },
      ]);
    });

    it('should complete the upload into an object of the summed size', async () => {
      const parts = await storage.listParts(key, uploadId);

      await storage.completeMultipartUpload(key, uploadId, parts!);

      await expect(storage.headObject(key)).resolves.toEqual({
        contentLength: FIRST_PART_SIZE + LAST_PART_SIZE,
      });
    });

    it('should serve byte ranges through the presigned GET URL', async () => {
      const { url, expiresIn } = await storage.presignGet(key);

      const response = await fetch(url, {
        headers: { Range: 'bytes=0-99' },
      });
      const body = Buffer.from(await response.arrayBuffer());

      expect(url.startsWith(config.publicEndpoint!)).toBe(true);
      expect(expiresIn).toBe(config.deliveryUrlTtlSeconds);
      expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe(
        String(config.deliveryUrlTtlSeconds),
      );
      expect(response.status).toBe(206);
      expect(body).toHaveLength(100);
      expect(body.equals(firstPart.subarray(0, 100))).toBe(true);
    });

    it('should reflect responseContentDisposition in the GET response', async () => {
      const disposition = 'attachment; filename="my-video.mp4"';
      const { url } = await storage.presignGet(key, {
        responseContentDisposition: disposition,
      });

      const response = await fetch(url, {
        headers: { Range: 'bytes=0-0' },
      });
      await response.arrayBuffer();

      expect(response.headers.get('content-disposition')).toBe(disposition);
    });

    it('should sign server-side read URLs for the internal endpoint that MinIO serves', async () => {
      const url = await storage.presignInternalGet(key);

      const response = await fetch(url, {
        headers: { Range: 'bytes=0-9' },
      });
      await response.arrayBuffer();

      expect(url.startsWith(config.endpoint!)).toBe(true);
      expect(response.status).toBe(206);
    });
  });

  describe('abortMultipartUpload', () => {
    it('should be idempotent and make listParts return null', async () => {
      const key = `${prefix}aborted/original`;
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

      await storage.abortMultipartUpload(key, uploadId);
      await expect(
        storage.abortMultipartUpload(key, uploadId),
      ).resolves.toBeUndefined();
      await expect(storage.listParts(key, uploadId)).resolves.toBeNull();
    });
  });

  describe('object operations', () => {
    it('should return null from headObject for a missing key', async () => {
      await expect(
        storage.headObject(`${prefix}does-not-exist`),
      ).resolves.toBeNull();
    });

    it('should put and delete a single object', async () => {
      const key = `${prefix}single/thumbnail.jpg`;
      await storage.putObject(key, Buffer.from('jpeg-bytes'), 'image/jpeg');
      await expect(storage.headObject(key)).resolves.toEqual({
        contentLength: 10,
      });

      await storage.deleteObject(key);

      await expect(storage.headObject(key)).resolves.toBeNull();
    });

    it('should delete every object under a prefix', async () => {
      const scoped = `${prefix}to-delete/`;
      await storage.putObject(`${scoped}a`, Buffer.from('a'), 'text/plain');
      await storage.putObject(`${scoped}b`, Buffer.from('b'), 'text/plain');

      await storage.deletePrefix(scoped);

      await expect(storage.headObject(`${scoped}a`)).resolves.toBeNull();
      await expect(storage.headObject(`${scoped}b`)).resolves.toBeNull();
    });
  });
});
