import { buildAttachmentDisposition } from './content-disposition.util';

describe('buildAttachmentDisposition', () => {
  it('should keep a plain ASCII name in both parameters', () => {
    expect(buildAttachmentDisposition('clip.mp4')).toBe(
      `attachment; filename="clip.mp4"; filename*=UTF-8''clip.mp4`,
    );
  });

  it('should percent-encode spaces in filename* and keep them in the fallback', () => {
    expect(buildAttachmentDisposition('my clip.mp4')).toBe(
      `attachment; filename="my clip.mp4"; filename*=UTF-8''my%20clip.mp4`,
    );
  });

  it('should replace accents with _ in the fallback and encode them in filename*', () => {
    expect(buildAttachmentDisposition('férias.mp4')).toBe(
      `attachment; filename="f_rias.mp4"; filename*=UTF-8''f%C3%A9rias.mp4`,
    );
  });

  it('should replace an emoji with a single _ in the fallback', () => {
    const header = buildAttachmentDisposition('🎬 trip.webm');

    expect(header).toContain('filename="_ trip.webm"');
    expect(header).toContain(`filename*=UTF-8''%F0%9F%8E%AC%20trip.webm`);
  });

  it('should neutralise quotes and backslashes in the fallback', () => {
    const header = buildAttachmentDisposition('say "hi"\\now.mp4');

    expect(header).toContain('filename="say _hi__now.mp4"');
    expect(header).toContain(`filename*=UTF-8''say%20%22hi%22%5Cnow.mp4`);
  });

  it('should neutralise control characters in the fallback', () => {
    const header = buildAttachmentDisposition('a\r\nb.mp4');

    expect(header).toContain('filename="a__b.mp4"');
    expect(header).not.toMatch(/[\r\n]/);
  });

  it("should encode characters RFC 5987 does not allow in filename* (' ( ) *)", () => {
    expect(buildAttachmentDisposition("it's (1)*.mp4")).toContain(
      `filename*=UTF-8''it%27s%20%281%29%2A.mp4`,
    );
  });
});
