import { applyDecorators, Header, Redirect } from '@nestjs/common';
import { ApiOperation, ApiResponse, getSchemaPath } from '@nestjs/swagger';
import { ApiErrorEnvelope } from '../../common/openapi/api-error-envelope.dto';

/**
 * Shared shape of the delivery routes: a 302 to a presigned storage URL that
 * must not be cached (it is a portable credential until it expires).
 */
export function ApiDeliveryRedirect(
  summary: string,
  description: string,
  notReadyDescription = 'VIDEO_NOT_READY — the video is not ready',
): MethodDecorator {
  return applyDecorators(
    // The handler returns the target URL; the decorator only sets the default
    Redirect(),
    Header('Cache-Control', 'private, no-store'),
    ApiOperation({ summary, description }),
    ApiResponse({
      status: 302,
      description: 'Redirect to a short-lived presigned storage URL',
      headers: {
        Location: { schema: { type: 'string', format: 'uri' } },
        'Cache-Control': {
          schema: { type: 'string', example: 'private, no-store' },
        },
      },
    }),
    ApiResponse({
      status: 400,
      description: 'VALIDATION_ERROR — `id` is not a UUID',
      schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
    }),
    ApiResponse({
      status: 401,
      description: 'Missing or invalid access token',
      schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
    }),
    ApiResponse({
      status: 404,
      description:
        'VIDEO_NOT_FOUND — the video does not exist or belongs to another channel',
      schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
    }),
    ApiResponse({
      status: 409,
      description: notReadyDescription,
      schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
    }),
  );
}
