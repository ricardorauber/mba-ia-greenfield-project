import { ApiProperty } from '@nestjs/swagger';
import type { Video } from '../entities/video.entity';
import type { UploadPlan } from '../video-uploads.service';
import { VideoResponseDto } from './video-response.dto';

export class UploadPlanDto implements UploadPlan {
  @ApiProperty({ type: 'integer', example: 67108864 })
  part_size: number;

  @ApiProperty({ type: 'integer', example: 1 })
  part_count: number;
}

export class CreateVideoResponseDto extends VideoResponseDto {
  @ApiProperty({ type: UploadPlanDto })
  upload: UploadPlanDto;

  static from(video: Video, upload: UploadPlan): CreateVideoResponseDto {
    const dto = new CreateVideoResponseDto();
    VideoResponseDto.assign(dto, video);
    dto.upload = { part_size: upload.part_size, part_count: upload.part_count };
    return dto;
  }
}
