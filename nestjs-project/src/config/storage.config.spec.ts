import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from './storage.config';

const STORAGE_ENV_KEYS = [
  'S3_ENDPOINT',
  'S3_PUBLIC_ENDPOINT',
  'S3_FORCE_PATH_STYLE',
  'S3_UPLOAD_PART_URL_TTL_SECONDS',
  'S3_DELIVERY_URL_TTL_SECONDS',
] as const;

const loadConfig = async (
  env: Partial<Record<(typeof STORAGE_ENV_KEYS)[number], string>>,
): Promise<ConfigType<typeof storageConfig>> => {
  for (const key of STORAGE_ENV_KEYS) {
    delete process.env[key];
  }
  Object.assign(process.env, env);

  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ ignoreEnvFile: true, load: [storageConfig] }),
    ],
  }).compile();

  const config = module.get<ConfigType<typeof storageConfig>>(
    storageConfig.KEY,
  );
  await module.close();
  return config;
};

describe('storageConfig', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('forcePathStyle', () => {
    it('should be true when S3_FORCE_PATH_STYLE=true', async () => {
      const config = await loadConfig({ S3_FORCE_PATH_STYLE: 'true' });
      expect(config.forcePathStyle).toBe(true);
    });

    it('should be false when S3_FORCE_PATH_STYLE=false', async () => {
      const config = await loadConfig({ S3_FORCE_PATH_STYLE: 'false' });
      expect(config.forcePathStyle).toBe(false);
    });

    it('should default to true when S3_FORCE_PATH_STYLE is not set', async () => {
      const config = await loadConfig({});
      expect(config.forcePathStyle).toBe(true);
    });
  });

  describe('presigned URL TTLs', () => {
    it('should parse the TTLs as numbers', async () => {
      const config = await loadConfig({
        S3_UPLOAD_PART_URL_TTL_SECONDS: '900',
        S3_DELIVERY_URL_TTL_SECONDS: '7200',
      });

      expect(config.uploadPartUrlTtlSeconds).toBe(900);
      expect(config.deliveryUrlTtlSeconds).toBe(7200);
    });

    it('should default to 3600s for part uploads and 14400s for delivery', async () => {
      const config = await loadConfig({});

      expect(config.uploadPartUrlTtlSeconds).toBe(3600);
      expect(config.deliveryUrlTtlSeconds).toBe(14400);
    });
  });

  describe('publicEndpoint', () => {
    it('should use S3_PUBLIC_ENDPOINT when set', async () => {
      const config = await loadConfig({
        S3_ENDPOINT: 'http://minio:9000',
        S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
      });

      expect(config.endpoint).toBe('http://minio:9000');
      expect(config.publicEndpoint).toBe('http://localhost:9000');
    });

    it('should fall back to S3_ENDPOINT when S3_PUBLIC_ENDPOINT is not set', async () => {
      const config = await loadConfig({ S3_ENDPOINT: 'http://minio:9000' });

      expect(config.publicEndpoint).toBe('http://minio:9000');
    });

    it('should leave both endpoints undefined when neither is set (AWS)', async () => {
      const config = await loadConfig({});

      expect(config.endpoint).toBeUndefined();
      expect(config.publicEndpoint).toBeUndefined();
    });
  });
});
