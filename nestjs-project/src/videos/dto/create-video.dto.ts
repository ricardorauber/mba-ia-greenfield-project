import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Min } from 'class-validator';

export class CreateVideoDto {
  /** Original file name; its extension (.mp4 / .webm) must match `mime_type`. */
  @IsString()
  @Length(1, 255)
  file_name: string;

  /** Declared MIME type: `video/mp4` or `video/webm`. */
  @IsString()
  mime_type: string;

  /** Declared file size in bytes (at most 10737418240). */
  @IsInt()
  @Min(1)
  size: number;

  /** Video title; defaults to the file name without its extension. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 100)
  title?: string;
}
