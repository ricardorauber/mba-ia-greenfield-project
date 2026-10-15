import { MediaToolError } from './media-tool-error';

export interface ProbeResult {
  /**
   * Seconds, from the container or else the video stream; `null` when neither
   * declares it (e.g. still images).
   */
  duration: number | null;
  size: number | null;
  format_name: string;
  bit_rate: number | null;
  width: number;
  height: number;
  video_codec: string;
  audio_codec: string | null;
  frame_rate: number | null;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  duration?: string;
}

interface FfprobeOutput {
  format?: {
    format_name?: string;
    duration?: string;
    size?: string;
    bit_rate?: string;
  };
  streams?: FfprobeStream[];
}

const toNumber = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

// ffprobe reports rates as fractions: "25/1", "30000/1001"; "0/0" = unknown
const parseFrameRate = (fraction: string | undefined): number | null => {
  if (!fraction) return null;
  const [numerator, denominator] = fraction.split('/').map(Number);
  if (!denominator || !Number.isFinite(numerator)) return null;
  return numerator / denominator;
};

export function parseProbeOutput(json: unknown): ProbeResult {
  const output = (json ?? {}) as FfprobeOutput;
  const streams = output.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');

  if (!video?.codec_name || !video.width || !video.height) {
    throw new MediaToolError('invalid_media', 'Input has no video stream');
  }

  return {
    duration: toNumber(output.format?.duration) ?? toNumber(video.duration),
    size: toNumber(output.format?.size),
    format_name: output.format?.format_name ?? '',
    bit_rate: toNumber(output.format?.bit_rate),
    width: video.width,
    height: video.height,
    video_codec: video.codec_name,
    audio_codec: audio?.codec_name ?? null,
    frame_rate: parseFrameRate(video.avg_frame_rate),
  };
}
