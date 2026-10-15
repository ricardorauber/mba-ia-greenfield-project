// Object storage layout: one prefix per video (TD-06)

export const videoPrefix = (videoId: string): string => `videos/${videoId}/`;

export const videoOriginalKey = (videoId: string): string =>
  `${videoPrefix(videoId)}original`;

export const videoThumbnailKey = (videoId: string): string =>
  `${videoPrefix(videoId)}thumbnail.jpg`;
