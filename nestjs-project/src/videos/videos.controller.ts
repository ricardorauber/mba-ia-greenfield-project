import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
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
import { UploadStatusResponseDto } from './dto/upload-status-response.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { VideoUploadsService } from './video-uploads.service';
import { VideosService } from './videos.service';

// The auth rate limit must not block clients requesting batches of part URLs
@ApiTags('videos')
@ApiBearerAuth('access-token')
@SkipThrottle()
@Controller('videos')
export class VideosController {
  constructor(
    private readonly videosService: VideosService,
    private readonly videoUploadsService: VideoUploadsService,
  ) {}

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

  @Get(':id')
  @ApiOperation({
    summary: 'Get a video',
    description:
      "Returns the caller's video in any status, so clients can poll processing progress and read the slug that forms the video's unique URL.",
  })
  @ApiResponse({
    status: 200,
    description: 'The video',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'VALIDATION_ERROR — `id` is not a UUID',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description:
      'VIDEO_NOT_FOUND — the video does not exist or belongs to another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async findOne(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<VideoResponseDto> {
    const video = await this.videosService.findOwnedOrFail(user.sub, id);
    return VideoResponseDto.fromEntity(video);
  }

  @Get(':id/upload')
  @ApiOperation({
    summary: 'Get the upload status',
    description:
      'Lists the parts already stored for a draft, so an interrupted upload can resume by sending only the missing parts.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload part plan and the parts already stored',
    type: UploadStatusResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'VALIDATION_ERROR — `id` is not a UUID',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description:
      'VIDEO_NOT_FOUND — the video does not exist or belongs to another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'INVALID_VIDEO_STATUS — the video is no longer a draft',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getUploadStatus(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<UploadStatusResponseDto> {
    const status = await this.videoUploadsService.getUploadStatus(user.sub, id);
    return UploadStatusResponseDto.from(status);
  }
}
