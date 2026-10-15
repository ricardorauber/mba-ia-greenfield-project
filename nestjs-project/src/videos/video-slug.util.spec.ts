import { generateVideoSlug } from './video-slug.util';

describe('generateVideoSlug', () => {
  it('should return 11 base64url characters', () => {
    const slug = generateVideoSlug();

    expect(slug).toMatch(/^[A-Za-z0-9_-]{11}$/);
  });

  it('should not repeat across 1000 calls', () => {
    const slugs = new Set(
      Array.from({ length: 1000 }, () => generateVideoSlug()),
    );

    expect(slugs.size).toBe(1000);
  });
});
