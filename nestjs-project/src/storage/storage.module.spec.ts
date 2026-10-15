import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const INTERNAL_ENDPOINT = 'http://internal-s3.test:9000';
const PUBLIC_ENDPOINT = 'http://public-s3.test:9000';

describe('StorageModule', () => {
  const originalEnv = { ...process.env };
  let module: TestingModule;

  beforeAll(async () => {
    process.env.S3_ENDPOINT = INTERNAL_ENDPOINT;
    process.env.S3_PUBLIC_ENDPOINT = PUBLIC_ENDPOINT;

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [storageConfig],
        }),
        StorageModule,
      ],
    }).compile();
  });

  afterAll(async () => {
    await module.close();
    process.env = { ...originalEnv };
  });

  it('should compile and expose StorageService', () => {
    expect(module.get(StorageService)).toBeInstanceOf(StorageService);
  });

  // Presigning is a local HMAC computation, so this exercises each client's
  // endpoint without touching the network.
  it('should sign server-side URLs with the internal endpoint', async () => {
    const url = await module
      .get(StorageService)
      .presignInternalGet('videos/abc/original');

    expect(new URL(url).origin).toBe(INTERNAL_ENDPOINT);
  });

  it('should sign browser-facing URLs with the public endpoint', async () => {
    const service = module.get(StorageService);

    const { url: getUrl } = await service.presignGet('videos/abc/original');
    const { url: partUrl } = await service.presignUploadPart(
      'videos/abc/original',
      'upload-id',
      1,
    );

    expect(new URL(getUrl).origin).toBe(PUBLIC_ENDPOINT);
    expect(new URL(partUrl).origin).toBe(PUBLIC_ENDPOINT);
  });
});
