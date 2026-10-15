import { ApiProperty } from '@nestjs/swagger';
import type { PartUrl, PartUrls } from '../video-uploads.service';

export class PartUrlDto implements PartUrl {
  @ApiProperty({ type: 'integer', example: 1 })
  part_number: number;

  @ApiProperty({
    description: 'Presigned URL: PUT the part bytes here, without auth headers',
    example:
      'http://localhost:9000/streamtube-videos/videos/{id}/original?partNumber=1&uploadId=...',
  })
  url: string;
}

export class PartUrlsResponseDto implements PartUrls {
  @ApiProperty({
    type: 'integer',
    description: 'Seconds the URLs stay valid',
    example: 3600,
  })
  expires_in: number;

  @ApiProperty({
    type: [PartUrlDto],
    description: 'In the same order as the requested part_numbers',
  })
  parts: PartUrlDto[];

  static from(result: PartUrls): PartUrlsResponseDto {
    const dto = new PartUrlsResponseDto();
    dto.expires_in = result.expires_in;
    dto.parts = result.parts.map((part) => ({
      part_number: part.part_number,
      url: part.url,
    }));
    return dto;
  }
}
