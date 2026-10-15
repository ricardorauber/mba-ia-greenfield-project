import { classifyFfmpegFailure, MediaToolError } from './media-tool-error';

const exitError = (message = 'Command failed') =>
  Object.assign(new Error(message), { code: 1, killed: false, signal: null });

describe('classifyFfmpegFailure', () => {
  it.each([
    'input.mp4: Invalid data found when processing input',
    '[mov,mp4,m4a,3gp,3g2,mj2 @ 0x55] moov atom not found',
    '[matroska,webm @ 0x55] EBML header parsing failed',
  ])('should classify "%s" as invalid_media', (stderr) => {
    const error = classifyFfmpegFailure(stderr, exitError());

    expect(error).toBeInstanceOf(MediaToolError);
    expect(error.kind).toBe('invalid_media');
  });

  it.each([
    'http://minio:9000/x: Server returned 5XX Server Error reply',
    'Connection to tcp://minio:9000 failed: Connection refused',
    'Connection reset by peer',
    'http://minio:9000/x: Server returned 404 Not Found',
    'some message nobody anticipated',
  ])('should classify "%s" as transient', (stderr) => {
    expect(classifyFfmpegFailure(stderr, exitError()).kind).toBe('transient');
  });

  it('should classify a process killed by the timeout as transient', () => {
    const timeout = Object.assign(new Error('Command failed'), {
      killed: true,
      signal: 'SIGTERM',
    });

    const error = classifyFfmpegFailure('', timeout);

    expect(error.kind).toBe('transient');
    expect(error.message).toMatch(/timed out/);
  });

  it('should treat a timeout as transient even when stderr looks permanent', () => {
    const timeout = Object.assign(new Error('Command failed'), {
      killed: true,
      signal: 'SIGTERM',
    });

    expect(
      classifyFfmpegFailure('Invalid data found when processing input', timeout)
        .kind,
    ).toBe('transient');
  });

  it('should keep stderr as the message and the original error as cause', () => {
    const original = exitError();

    const error = classifyFfmpegFailure('  moov atom not found\n', original);

    expect(error.message).toBe('moov atom not found');
    expect(error.cause).toBe(original);
  });

  it('should fall back to the process error message when stderr is empty', () => {
    const error = classifyFfmpegFailure('', exitError('spawn ffprobe ENOENT'));

    expect(error.kind).toBe('transient');
    expect(error.message).toBe('spawn ffprobe ENOENT');
  });
});
