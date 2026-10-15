import { ApiProperty } from '@nestjs/swagger';
import {
  type Video,
  type VideoMetadata,
  VideoStatus,
} from '../entities/video.entity';

export class VideoMetadataDto implements VideoMetadata {
  @ApiProperty({ example: 'h264' })
  video_codec: string;

  @ApiProperty({ type: String, nullable: true, example: 'aac' })
  audio_codec: string | null;

  @ApiProperty({ example: 'mov,mp4,m4a,3gp,3g2,mj2' })
  format_name: string;

  @ApiProperty({ type: Number, nullable: true, example: 1500000 })
  bit_rate: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 29.97 })
  frame_rate: number | null;
}

export class VideoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    description: 'Unique 11-character base64url identifier of the video URL',
    example: 'dQw4w9WgXcQ',
  })
  slug: string;

  @ApiProperty({ example: 'My video' })
  title: string;

  @ApiProperty({ example: 'my-video.mp4' })
  original_filename: string;

  @ApiProperty({ enum: ['video/mp4', 'video/webm'], example: 'video/mp4' })
  mime_type: string;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;

  @ApiProperty({
    type: String,
    nullable: true,
    enum: [
      'upload_abandoned',
      'size_mismatch',
      'unsupported_format',
      'invalid_media',
      'processing_error',
    ],
  })
  failure_reason: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Duration in seconds',
    example: 12.5,
  })
  duration: number | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 1920 })
  width: number | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 1080 })
  height: number | null;

  @ApiProperty({
    type: 'integer',
    format: 'int64',
    nullable: true,
    description: 'Stored size in bytes',
  })
  size: number | null;

  @ApiProperty({ type: VideoMetadataDto, nullable: true })
  metadata: VideoMetadataDto | null;

  @ApiProperty()
  has_thumbnail: boolean;

  @ApiProperty({ format: 'date-time' })
  created_at: string;

  @ApiProperty({ format: 'date-time' })
  updated_at: string;

  static fromEntity(video: Video): VideoResponseDto {
    const dto = new VideoResponseDto();
    VideoResponseDto.assign(dto, video);
    return dto;
  }

  protected static assign(target: VideoResponseDto, video: Video): void {
    target.id = video.id;
    target.slug = video.slug;
    target.title = video.title;
    target.original_filename = video.original_filename;
    target.mime_type = video.mime_type;
    target.status = video.status;
    target.failure_reason = video.failure_reason;
    target.duration = video.duration;
    target.width = video.width;
    target.height = video.height;
    target.size = video.size;
    target.metadata = video.metadata;
    target.has_thumbnail = video.has_thumbnail;
    target.created_at = video.created_at.toISOString();
    target.updated_at = video.updated_at.toISOString();
  }
}
