import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ACCESS_KEY_ID: 'access-key',
  S3_SECRET_ACCESS_KEY: 'secret-key',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — object storage', () => {
  it.each(['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'])(
    'should reject a missing %s',
    (key) => {
      const env: Record<string, string> = { ...requiredEnv };
      delete env[key];

      const { error } = envValidationSchema.validate(env, {
        allowUnknown: true,
        abortEarly: false,
      });

      expect(error).toBeDefined();
      expect(error!.message).toContain(key);
    },
  );

  it('should apply the storage defaults when optional variables are not set', () => {
    const { value, error } = validate({});

    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'streamtube-videos',
      S3_FORCE_PATH_STYLE: 'true',
      S3_UPLOAD_PART_URL_TTL_SECONDS: 3600,
      S3_DELIVERY_URL_TTL_SECONDS: 14400,
    });
  });

  it.each(['S3_UPLOAD_PART_URL_TTL_SECONDS', 'S3_DELIVERY_URL_TTL_SECONDS'])(
    'should reject %s below 60 seconds',
    (key) => {
      const { error } = validate({ [key]: '30' });

      expect(error).toBeDefined();
      expect(error!.message).toContain(key);
    },
  );

  it.each(['S3_UPLOAD_PART_URL_TTL_SECONDS', 'S3_DELIVERY_URL_TTL_SECONDS'])(
    'should reject %s above the 7-day SigV4 limit',
    (key) => {
      const { error } = validate({ [key]: '604801' });

      expect(error).toBeDefined();
      expect(error!.message).toContain(key);
    },
  );

  it('should reject S3_FORCE_PATH_STYLE with an invalid value', () => {
    const { error } = validate({ S3_FORCE_PATH_STYLE: 'yes' });

    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_FORCE_PATH_STYLE');
  });

  it('should reject S3_ENDPOINT that is not a URI', () => {
    const { error } = validate({ S3_ENDPOINT: 'not a url' });

    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_ENDPOINT');
  });
});

describe('envValidationSchema — queue', () => {
  it('should apply the Redis and queue defaults when not set', () => {
    const { value, error } = validate({});

    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      REDIS_HOST: 'redis',
      REDIS_PORT: 6379,
      QUEUE_PREFIX: 'streamtube',
    });
  });

  it('should reject REDIS_PORT outside the valid port range', () => {
    const { error } = validate({ REDIS_PORT: '70000' });

    expect(error).toBeDefined();
    expect(error!.message).toContain('REDIS_PORT');
  });
});

describe('Jest test environment isolation', () => {
  it('should override the dev queue prefix and public storage endpoint', () => {
    expect(process.env.QUEUE_PREFIX).toBe('streamtube-test');
    expect(process.env.S3_PUBLIC_ENDPOINT).toBe('http://minio:9000');
  });
});
