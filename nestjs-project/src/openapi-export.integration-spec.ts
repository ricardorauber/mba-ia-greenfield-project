import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportSpec } from './openapi-export';

describe('exportSpec (integration)', () => {
  let outputPath: string;
  let document: Record<string, unknown>;

  beforeAll(async () => {
    outputPath = join(tmpdir(), `openapi-test-${Date.now()}.json`);
    await exportSpec(outputPath);
    document = JSON.parse(readFileSync(outputPath, 'utf-8')) as Record<
      string,
      unknown
    >;
  }, 30_000);

  it('exports a valid OpenAPI 3.x document', () => {
    expect(document.openapi).toMatch(/^3\./);
  });

  it('sets info.title to "StreamTube API"', () => {
    const info = document.info as Record<string, unknown>;
    expect(info.title).toBe('StreamTube API');
  });

  it('sets info.version to "1.0"', () => {
    const info = document.info as Record<string, unknown>;
    expect(info.version).toBe('1.0');
  });

  it('includes access-token Bearer security scheme', () => {
    const components = document.components as Record<string, unknown>;
    const schemes = components.securitySchemes as Record<
      string,
      Record<string, unknown>
    >;
    expect(schemes['access-token']).toMatchObject({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
  });

  it('includes non-empty components.schemas from DTO inference', () => {
    const components = document.components as Record<string, unknown>;
    const schemas = components.schemas as Record<string, unknown>;
    expect(Object.keys(schemas).length).toBeGreaterThan(0);
  });

  it('includes ApiErrorEnvelope schema with expected properties', () => {
    const components = document.components as Record<string, unknown>;
    const schemas = components.schemas as Record<
      string,
      Record<string, unknown>
    >;
    expect(schemas['ApiErrorEnvelope']).toBeDefined();
    const props = schemas['ApiErrorEnvelope'].properties as Record<
      string,
      unknown
    >;
    expect(props).toHaveProperty('statusCode');
    expect(props).toHaveProperty('error');
    expect(props).toHaveProperty('message');
    expect(props).toHaveProperty('code');
  });

  it('has at least one path with a 401 response referencing ApiErrorEnvelope', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const apiErrorRef = '#/components/schemas/ApiErrorEnvelope';

    const hasRef = Object.values(paths).some((methods) =>
      Object.values(methods).some((operation) => {
        const responses = operation.responses as Record<
          string,
          Record<string, unknown>
        >;
        const r401 = responses?.['401'];
        if (!r401) return false;
        const content = r401.content as Record<string, Record<string, unknown>>;
        const jsonContent = content?.['application/json'];
        const schema = jsonContent?.schema as Record<string, unknown>;
        return schema?.['$ref'] === apiErrorRef;
      }),
    );

    expect(hasRef).toBe(true);
  });

  it('protected auth endpoints include access-token security requirement', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const protectedPaths = [
      { path: '/auth/logout', method: 'post' },
      { path: '/auth/me', method: 'get' },
    ];

    for (const { path, method } of protectedPaths) {
      const operation = paths[path]?.[method];
      expect(operation).toBeDefined();
      const security = operation?.security as Array<Record<string, unknown>>;
      expect(security).toBeDefined();
      expect(security.some((req) => 'access-token' in req)).toBe(true);
    }
  });

  it('all auth endpoints have a non-empty summary', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const authPaths = Object.entries(paths).filter(([p]) =>
      p.startsWith('/auth/'),
    );

    expect(authPaths.length).toBeGreaterThan(0);

    for (const [, methods] of authPaths) {
      for (const operation of Object.values(methods)) {
        expect(typeof operation.summary).toBe('string');
        expect((operation.summary as string).length).toBeGreaterThan(0);
      }
    }
  });

  describe('videos contract', () => {
    type Operation = {
      tags?: string[];
      security?: Array<Record<string, unknown>>;
      responses: Record<string, Record<string, any>>;
    };
    const VIDEO_OPERATIONS = [
      { path: '/videos', method: 'post' },
      { path: '/videos/{id}', method: 'get' },
      { path: '/videos/{id}/upload', method: 'get' },
      { path: '/videos/{id}/upload/part-urls', method: 'post' },
      { path: '/videos/{id}/upload/complete', method: 'post' },
      { path: '/videos/{id}/stream', method: 'get' },
      { path: '/videos/{id}/download', method: 'get' },
      { path: '/videos/{id}/thumbnail', method: 'get' },
    ];
    const REDIRECT_PATHS = [
      '/videos/{id}/stream',
      '/videos/{id}/download',
      '/videos/{id}/thumbnail',
    ];
    const apiErrorRef = '#/components/schemas/ApiErrorEnvelope';

    const operation = (path: string, method: string): Operation => {
      const paths = document.paths as Record<string, Record<string, Operation>>;
      return paths[path]?.[method];
    };

    it.each(VIDEO_OPERATIONS)(
      'documents $method $path under the videos tag with access-token security',
      ({ path, method }) => {
        const op = operation(path, method);

        expect(op).toBeDefined();
        expect(op.tags).toEqual(['videos']);
        expect(op.security?.some((req) => 'access-token' in req)).toBe(true);
      },
    );

    it.each(VIDEO_OPERATIONS)(
      'references ApiErrorEnvelope in every error response of $method $path',
      ({ path, method }) => {
        const errors = Object.entries(operation(path, method).responses).filter(
          ([status]) => Number(status) >= 400,
        );

        expect(errors.map(([status]) => status)).toEqual(
          expect.arrayContaining(['400', '401', '404']),
        );
        for (const [, response] of errors) {
          expect(response.content['application/json'].schema.$ref).toBe(
            apiErrorRef,
          );
        }
      },
    );

    it.each(REDIRECT_PATHS)(
      'documents GET %s as a 302 with a Location header',
      (path) => {
        const responses = operation(path, 'get').responses;

        expect(responses['302'].headers.Location.schema).toEqual({
          type: 'string',
          format: 'uri',
        });
        expect(responses['409']).toBeDefined();
      },
    );

    it('declares the VideoResponseDto status enum and nullable processing fields', () => {
      const components = document.components as Record<string, any>;
      const props = components.schemas.VideoResponseDto.properties;

      expect(props.status.enum).toEqual([
        'draft',
        'processing',
        'ready',
        'failed',
      ]);
      for (const field of [
        'failure_reason',
        'duration',
        'width',
        'height',
        'size',
        'metadata',
      ]) {
        expect(props[field].nullable).toBe(true);
      }
    });

    it('is reflected in the committed openapi.json', () => {
      const committed = JSON.parse(
        readFileSync(join(__dirname, '..', 'openapi.json'), 'utf-8'),
      ) as { paths: Record<string, Record<string, unknown>> };

      for (const { path, method } of VIDEO_OPERATIONS) {
        expect(committed.paths[path]?.[method]).toBeDefined();
      }
    });
  });
});
