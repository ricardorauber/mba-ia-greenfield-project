import type { ProbeResult } from './media/probe-parser';
import { PermanentProcessingError } from './video-processing-errors';

interface PlaybackRule {
  /** Substring expected in ffprobe's `format_name` */
  container: string;
  videoCodecs: readonly string[];
  /** `null` = no audio stream, which browsers play fine */
  audioCodecs: readonly (string | null)[];
}

// Combinations every major browser plays natively (TD-09)
const PLAYBACK_RULES: Readonly<Record<string, PlaybackRule>> = {
  'video/mp4': {
    container: 'mp4',
    videoCodecs: ['h264'],
    audioCodecs: ['aac', 'mp3', null],
  },
  'video/webm': {
    container: 'webm',
    videoCodecs: ['vp8', 'vp9', 'av1'],
    audioCodecs: ['opus', 'vorbis', null],
  },
};

/** The real file must match the declared MIME type and be browser-playable. */
export function assertPlayable(
  declaredMimeType: string,
  probe: ProbeResult,
): void {
  const rule = PLAYBACK_RULES[declaredMimeType];
  const playable =
    rule !== undefined &&
    probe.format_name.split(',').includes(rule.container) &&
    rule.videoCodecs.includes(probe.video_codec) &&
    rule.audioCodecs.includes(probe.audio_codec);

  if (!playable) {
    throw new PermanentProcessingError(
      'unsupported_format',
      `Declared ${declaredMimeType} but found ${probe.format_name} with ${probe.video_codec}/${probe.audio_codec ?? 'no audio'}`,
    );
  }
}
