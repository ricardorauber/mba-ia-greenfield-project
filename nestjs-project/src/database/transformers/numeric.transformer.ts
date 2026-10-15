import type { ValueTransformer } from 'typeorm';

/**
 * node-postgres returns `bigint` and `numeric` as strings to avoid precision
 * loss. Values handled here (≤ 10 GiB byte counts, durations in seconds) fit
 * safely in a JS number, so they are exposed as `number`.
 */
export const numericTransformer: ValueTransformer = {
  to: (value: number | null | undefined) => value,
  from: (value: string | null): number | null =>
    value === null ? null : Number(value),
};
