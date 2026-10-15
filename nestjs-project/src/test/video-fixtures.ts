import { execFile } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface VideoFixtures {
  dir: string;
  /** H.264 + AAC, 3 s, 320x240, 25 fps */
  mp4: string;
  /** VP9 + Opus, 3 s, 320x240 */
  webm: string;
  /** H.264 without an audio stream */
  mp4NoAudio: string;
  /** H.264 + AAC, 0.5 s (thumbnail at 0 s) */
  mp4Short: string;
  /** H.264, 1920x1080, 1 s */
  mp4FullHd: string;
  /** MPEG-4 Part 2 video in an MP4 container (codec outside the allowlist) */
  mp4Mpeg4Part2: string;
  /** First KiB of `mp4`: no moov atom, unreadable */
  mp4Corrupt: string;
  cleanup: () => Promise<void>;
}

const testVideo = (seconds: number, size: string): string[] => [
  '-f',
  'lavfi',
  '-i',
  `testsrc=duration=${seconds}:size=${size}:rate=25`,
];

const testAudio = (seconds: number): string[] => [
  '-f',
  'lavfi',
  '-i',
  `sine=frequency=440:duration=${seconds}`,
];

async function ffmpeg(args: string[], output: string): Promise<void> {
  await execFileAsync('ffmpeg', ['-v', 'error', '-y', ...args, output]);
}

/** Generates small real clips in a temp dir; call `cleanup()` in `afterAll`. */
export async function createVideoFixtures(): Promise<VideoFixtures> {
  const dir = await mkdtemp(join(tmpdir(), 'streamtube-fixtures-'));
  const path = (name: string): string => join(dir, name);
  const h264 = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'];

  const fixtures: VideoFixtures = {
    dir,
    mp4: path('h264-aac.mp4'),
    webm: path('vp9-opus.webm'),
    mp4NoAudio: path('h264-no-audio.mp4'),
    mp4Short: path('h264-short.mp4'),
    mp4FullHd: path('h264-1080p.mp4'),
    mp4Mpeg4Part2: path('mpeg4-part2.mp4'),
    mp4Corrupt: path('corrupt.mp4'),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };

  await ffmpeg(
    [...testVideo(3, '320x240'), ...testAudio(3), ...h264, '-c:a', 'aac'],
    fixtures.mp4,
  );
  await ffmpeg(
    [
      ...testVideo(3, '320x240'),
      ...testAudio(3),
      '-c:v',
      'libvpx-vp9',
      '-deadline',
      'realtime',
      '-c:a',
      'libopus',
    ],
    fixtures.webm,
  );
  await ffmpeg([...testVideo(3, '320x240'), ...h264], fixtures.mp4NoAudio);
  await ffmpeg(
    [...testVideo(0.5, '320x240'), ...testAudio(0.5), ...h264, '-c:a', 'aac'],
    fixtures.mp4Short,
  );
  await ffmpeg(
    [...testVideo(1, '1920x1080'), ...h264, '-preset', 'ultrafast'],
    fixtures.mp4FullHd,
  );
  await ffmpeg(
    [...testVideo(1, '320x240'), '-c:v', 'mpeg4'],
    fixtures.mp4Mpeg4Part2,
  );

  // ffmpeg writes the moov atom at the end, so the head alone is unreadable
  const original = await readFile(fixtures.mp4);
  await writeFile(fixtures.mp4Corrupt, original.subarray(0, 1024));

  return fixtures;
}
