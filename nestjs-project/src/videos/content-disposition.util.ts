// Non-printable-ASCII, quotes and backslashes cannot sit inside a quoted
// `filename` parameter; they become `_` in the fallback
const UNSAFE_FALLBACK_CHARS = /[^\x20-\x7e]|["\\]/gu;

// encodeURIComponent leaves these unescaped, but RFC 5987 attr-char does not
// allow them (`'` is the ext-value delimiter)
const NON_ATTR_CHARS = /['()*]/g;

/**
 * `Content-Disposition` for downloads: an ASCII-safe `filename` for old
 * clients plus the exact name as RFC 5987 `filename*`.
 */
export function buildAttachmentDisposition(filename: string): string {
  const fallback = filename.replace(UNSAFE_FALLBACK_CHARS, '_');
  const encoded = encodeURIComponent(filename).replace(
    NON_ATTR_CHARS,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
