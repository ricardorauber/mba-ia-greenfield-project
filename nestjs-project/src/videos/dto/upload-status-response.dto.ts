import { ApiProperty } from '@nestjs/swagger';
import type {
  UploadedPartStatus,
  UploadStatus,
} from '../video-uploads.service';

export class UploadedPartDto implements UploadedPartStatus {
  @ApiProperty({ type: 'integer', example: 1 })
  part_number: number;

  @ApiProperty({ type: 'integer', example: 67108864 })
  size: number;
}

export class UploadStatusResponseDto implements UploadStatus {
  @ApiProperty({ type: 'integer', example: 67108864 })
  part_size: number;

  @ApiProperty({ type: 'integer', example: 3 })
  part_count: number;

  @ApiProperty({
    type: [UploadedPartDto],
    description: 'Parts already stored, ordered by part_number',
  })
  uploaded_parts: UploadedPartDto[];

  static from(status: UploadStatus): UploadStatusResponseDto {
    const dto = new UploadStatusResponseDto();
    dto.part_size = status.part_size;
    dto.part_count = status.part_count;
    dto.uploaded_parts = status.uploaded_parts.map((part) => ({
      part_number: part.part_number,
      size: part.size,
    }));
    return dto;
  }
}
