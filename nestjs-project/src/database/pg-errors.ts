import { QueryFailedError } from 'typeorm';

const PG_UNIQUE_VIOLATION = '23505';

interface PgErrorFields {
  code?: unknown;
  detail?: unknown;
}

export function isPgUniqueViolationOnColumn(
  err: unknown,
  column: string,
): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const e = err as PgErrorFields;
  return (
    e.code === PG_UNIQUE_VIOLATION &&
    typeof e.detail === 'string' &&
    e.detail.includes(column)
  );
}
