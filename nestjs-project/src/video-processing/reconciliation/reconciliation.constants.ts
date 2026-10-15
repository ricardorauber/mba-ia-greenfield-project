const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

// A draft still uploading after this long is abandoned (TD-10, TD-13)
export const ABANDONED_DRAFT_AFTER_MS = 24 * HOUR_MS;

// A video processing for this long lost its job somewhere (TD-13)
export const STUCK_PROCESSING_AFTER_MS = HOUR_MS;

export const RECONCILE_EVERY_MS = 15 * MINUTE_MS;

// Per case and per run, so a backlog drains over several runs
export const RECONCILE_BATCH_LIMIT = 100;
