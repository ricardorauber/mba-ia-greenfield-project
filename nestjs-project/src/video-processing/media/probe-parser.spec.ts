import { MediaToolError } from './media-tool-error';
import { parseProbeOutput } from './probe-parser';

const videoStream = {
  codec_type: 'video',
  codec_name: 'h264',
  width: 320,
  height: 240,
  avg_frame_rate: '25/1',
};
const audioStream = { codec_type: 'audio', codec_name: 'aac' };
const format = {
  format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
  duration: '3.000000',
  size: '52341',
  bit_rate: '139576',
};

describe('parseProbeOutput', () => {
  it('should map format and stream fields to numbers and codecs', () => {
    const result = parseProbeOutput({
      format,
      streams: [videoStream, audioStream],
    });

    expect(result).toEqual({
      duration: 3,
      size: 52341,
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      bit_rate: 139576,
      width: 320,
      height: 240,
      video_codec: 'h264',
      audio_codec: 'aac',
      frame_rate: 25,
    });
  });

  it('should convert a fractional frame rate', () => {
    const result = parseProbeOutput({
      format,
      streams: [{ ...videoStream, avg_frame_rate: '30000/1001' }],
    });

    expect(result.frame_rate).toBeCloseTo(29.97, 2);
  });

  it('should return a null frame rate for "0/0"', () => {
    const result = parseProbeOutput({
      format,
      streams: [{ ...videoStream, avg_frame_rate: '0/0' }],
    });

    expect(result.frame_rate).toBeNull();
  });

  it('should return a null audio codec when there is no audio stream', () => {
    const result = parseProbeOutput({ format, streams: [videoStream] });

    expect(result.audio_codec).toBeNull();
  });

  it('should use the first video stream and the first audio stream', () => {
    const result = parseProbeOutput({
      format,
      streams: [
        audioStream,
        videoStream,
        { ...videoStream, codec_name: 'mjpeg' },
        { codec_type: 'audio', codec_name: 'mp3' },
      ],
    });

    expect(result.video_codec).toBe('h264');
    expect(result.audio_codec).toBe('aac');
  });

  it('should return null for missing numeric format fields', () => {
    const result = parseProbeOutput({
      format: { format_name: 'image2' },
      streams: [videoStream],
    });

    expect(result).toMatchObject({
      duration: null,
      size: null,
      bit_rate: null,
    });
  });

  it.each([
    ['no streams', { format, streams: [] }],
    ['only audio', { format, streams: [audioStream] }],
    ['an empty object', {}],
  ])('should fail with invalid_media when there is %s', (_label, json) => {
    let error: unknown;
    try {
      parseProbeOutput(json);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(MediaToolError);
    expect((error as MediaToolError).kind).toBe('invalid_media');
  });
});
