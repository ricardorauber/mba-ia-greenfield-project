import type { ProbeResult } from './media/probe-parser';
import { assertPlayable } from './playback-allowlist';
import { PermanentProcessingError } from './video-processing-errors';

const MP4_FORMAT = 'mov,mp4,m4a,3gp,3g2,mj2';
const WEBM_FORMAT = 'matroska,webm';

const probe = (
  format_name: string,
  video_codec: string,
  audio_codec: string | null,
): ProbeResult => ({
  duration: 3,
  size: 1000,
  format_name,
  bit_rate: 1000,
  width: 320,
  height: 240,
  video_codec,
  audio_codec,
  frame_rate: 25,
});

const rejection = (mime: string, result: ProbeResult): unknown => {
  try {
    assertPlayable(mime, result);
  } catch (err) {
    return err;
  }
  return undefined;
};

describe('assertPlayable', () => {
  it.each([
    ['video/mp4', MP4_FORMAT, 'h264', 'aac'],
    ['video/mp4', MP4_FORMAT, 'h264', 'mp3'],
    ['video/mp4', MP4_FORMAT, 'h264', null],
    ['video/webm', WEBM_FORMAT, 'vp8', 'vorbis'],
    ['video/webm', WEBM_FORMAT, 'vp9', 'opus'],
    ['video/webm', WEBM_FORMAT, 'av1', 'opus'],
    ['video/webm', WEBM_FORMAT, 'vp9', null],
  ])('should accept %s in %s with %s/%s', (mime, format, video, audio) => {
    expect(() =>
      assertPlayable(mime, probe(format, video, audio)),
    ).not.toThrow();
  });

  it.each([
    ['WebM declared as video/mp4', 'video/mp4', WEBM_FORMAT, 'vp9', 'opus'],
    ['MP4 declared as video/webm', 'video/webm', MP4_FORMAT, 'h264', 'aac'],
    ['MPEG-4 Part 2 in MP4', 'video/mp4', MP4_FORMAT, 'mpeg4', 'aac'],
    ['HEVC in MP4', 'video/mp4', MP4_FORMAT, 'hevc', 'aac'],
    ['Opus audio in MP4', 'video/mp4', MP4_FORMAT, 'h264', 'opus'],
    ['H.264 in WebM/Matroska', 'video/webm', WEBM_FORMAT, 'h264', 'opus'],
    ['AAC audio in WebM', 'video/webm', WEBM_FORMAT, 'vp9', 'aac'],
    [
      'a MIME type outside the allowlist',
      'video/quicktime',
      MP4_FORMAT,
      'h264',
      'aac',
    ],
  ])(
    'should reject %s as unsupported_format',
    (_label, mime, format, video, audio) => {
      const error = rejection(mime, probe(format, video, audio));

      expect(error).toBeInstanceOf(PermanentProcessingError);
      expect((error as PermanentProcessingError).reason).toBe(
        'unsupported_format',
      );
    },
  );

  it('should not accept a container that merely contains "mp4" as a substring', () => {
    const error = rejection('video/mp4', probe('notmp4', 'h264', 'aac'));

    expect(error).toBeInstanceOf(PermanentProcessingError);
  });
});
