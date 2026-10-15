import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { numericTransformer } from '../../database/transformers/numeric.transformer';

export enum VideoStatus {
  Draft = 'draft',
  Processing = 'processing',
  Ready = 'ready',
  Failed = 'failed',
}

export type VideoFailureReason =
  | 'upload_abandoned'
  | 'size_mismatch'
  | 'unsupported_format'
  | 'invalid_media'
  | 'processing_error';

export interface VideoMetadata {
  video_codec: string;
  audio_codec: string | null;
  format_name: string;
  bit_rate: number | null;
  frame_rate: number | null;
}

@Entity('videos')
@Index(['status', 'created_at'])
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'varchar', length: 11, unique: true })
  slug: string;

  @Column({ type: 'varchar', length: 100 })
  title: string;

  @Column({ type: 'varchar', length: 255 })
  original_filename: string;

  @Column({ type: 'varchar', length: 50 })
  mime_type: string;

  @Column({ type: 'bigint', transformer: numericTransformer })
  declared_size: number;

  @Column({ type: 'text' })
  upload_id: string;

  @Column({ type: 'enum', enum: VideoStatus, default: VideoStatus.Draft })
  status: VideoStatus;

  @Column({ type: 'varchar', length: 50, nullable: true })
  failure_reason: VideoFailureReason | null;

  @Column({ type: 'timestamp', nullable: true })
  processing_started_at: Date | null;

  @Column({
    type: 'numeric',
    precision: 10,
    scale: 3,
    nullable: true,
    transformer: numericTransformer,
  })
  duration: number | null;

  @Column({ type: 'integer', nullable: true })
  width: number | null;

  @Column({ type: 'integer', nullable: true })
  height: number | null;

  @Column({
    type: 'bigint',
    nullable: true,
    transformer: numericTransformer,
  })
  size: number | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: VideoMetadata | null;

  @Column({ type: 'boolean', default: false })
  has_thumbnail: boolean;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => Channel, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
