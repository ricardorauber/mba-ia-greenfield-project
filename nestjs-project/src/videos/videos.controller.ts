import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CreateVideoResponseDto } from './dto/create-video-response.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { VideoUploadsService } from './video-uploads.service';

// The auth rate limit must not block clients requesting batches of part URLs
@ApiTags('videos')
@ApiBearerAuth('access-token')
@SkipThrottle()
@Controller('videos')
export class VideosController {
  constructor(private readonly videoUploadsService: VideoUploadsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      "Validates the declared format and size, opens a multipart upload in object storage and pre-registers the video as a draft in the caller's channel. The file itself is uploaded straight to storage through presigned part URLs.",
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created; returns the video and its upload part plan',
    type: CreateVideoResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'VALIDATION_ERROR, UNSUPPORTED_VIDEO_FORMAT (MIME type not allowed or extension mismatch) or VIDEO_TOO_LARGE (over 10 GiB)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'CHANNEL_NOT_FOUND — the authenticated user has no channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<CreateVideoResponseDto> {
    const { video, upload } = await this.videoUploadsService.initiate(
      user.sub,
      dto,
    );
    return CreateVideoResponseDto.from(video, upload);
  }
}
