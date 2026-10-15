import { execFile, type ExecFileException } from 'child_process';
import { Injectable } from '@nestjs/common';
import { classifyFfmpegFailure, MediaToolError } from './media-tool-error';
import { parseProbeOutput, type ProbeResult } from './probe-parser';

const PROBE_TIMEOUT_MS = 60_000;
const FRAME_TIMEOUT_MS = 120_000;
const PROBE_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const FRAME_MAX_BUFFER_BYTES = 20 * 1024 * 1024;

// Only meaningful for network inputs (presigned storage URLs)
const HTTP_RECONNECT_FLAGS = [
  '-reconnect',
  '1',
  '-reconnect_on_network_error',
  '1',
  '-reconnect_on_http_error',
  '5xx',
];

interface ProcessOutput<T> {
  stdout: T;
  stderr: string;
}

/**
 * ffprobe/ffmpeg run as child processes (no shell) so long media work never
 * blocks the worker's event loop; failures come back as `MediaToolError`.
 */
@Injectable()
export class MediaToolsService {
  async probe(input: string): Promise<ProbeResult> {
    const { stdout } = await this.run<string>(
      'ffprobe',
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        input,
      ],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BUFFER_BYTES },
    );

    let json: unknown;
    try {
      json = JSON.parse(stdout);
    } catch (err) {
      throw new MediaToolError('invalid_media', 'ffprobe output is not JSON', {
        cause: err,
      });
    }
    return parseProbeOutput(json);
  }

  /** One JPEG frame at `atSeconds`, scaled down to at most 1280 px wide. */
  async extractFrame(input: string, atSeconds: number): Promise<Buffer> {
    const reconnectFlags = /^https?:\/\//i.test(input)
      ? HTTP_RECONNECT_FLAGS
      : [];
    const { stdout } = await this.run<Buffer>(
      'ffmpeg',
      [
        '-v',
        'error',
        ...reconnectFlags,
        '-ss',
        String(atSeconds),
        '-i',
        input,
        '-frames:v',
        '1',
        '-vf',
        "scale='min(1280,iw)':-2",
        '-f',
        'image2',
        '-c:v',
        'mjpeg',
        'pipe:1',
      ],
      {
        encoding: 'buffer',
        timeout: FRAME_TIMEOUT_MS,
        maxBuffer: FRAME_MAX_BUFFER_BYTES,
      },
    );

    if (stdout.length === 0) {
      throw new MediaToolError('invalid_media', 'ffmpeg produced no frame');
    }
    return stdout;
  }

  private run<T extends string | Buffer>(
    command: string,
    args: string[],
    options: { timeout: number; maxBuffer: number; encoding?: 'buffer' },
  ): Promise<ProcessOutput<T>> {
    return new Promise((resolve, reject) => {
      execFile(
        command,
        args,
        { ...options, encoding: options.encoding ?? 'utf8' },
        (error: ExecFileException | null, stdout, stderr) => {
          const stderrText = stderr.toString();
          if (error) {
            reject(classifyFfmpegFailure(stderrText, error));
            return;
          }
          resolve({ stdout: stdout as T, stderr: stderrText });
        },
      );
    });
  }
}
