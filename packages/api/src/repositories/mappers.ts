// Shared column-mapping helpers used by the repositories.
//
// PostgreSQL returns snake_case columns and some values (numeric, vector) as
// strings via the `pg` driver. These pure helpers convert those raw values
// into the camelCase domain types reused from `@lumina/shared`, and serialize
// domain values back into the literal forms PostgreSQL expects (notably the
// `pgvector` text representation `[1,2,3]`). Keeping them pure makes them
// directly unit-testable and keeps every repository's mapping consistent.

/** Coerce a raw DB value to a string, throwing when it is null/undefined. */
export function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) {
    throw new Error('Expected a string column value but received null.');
  }
  return String(value);
}

/** Coerce a nullable raw DB value to `string | null`. */
export function asStringOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : asString(value);
}

/**
 * Coerce a raw DB value to a number. PostgreSQL `numeric` columns arrive as
 * strings through `pg`, so this accepts both numbers and numeric strings.
 */
export function asNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (!Number.isNaN(n)) return n;
  }
  throw new Error(`Expected a numeric column value but received: ${String(value)}`);
}

/** Coerce a nullable raw DB value to `number | null`. */
export function asNumberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : asNumber(value);
}

/** Coerce a raw DB value to a boolean (accepts pg booleans and `t`/`f`). */
export function asBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 't' || value === 'true') return true;
  if (value === 'f' || value === 'false') return false;
  throw new Error(`Expected a boolean column value but received: ${String(value)}`);
}

/**
 * Convert a `timestamptz` column to an ISO-8601 string. `pg` may return a
 * `Date` or, when date parsing is disabled, a string; both are normalized.
 */
export function asIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? value : new Date(ms).toISOString();
  }
  throw new Error(`Expected a timestamp column value but received: ${String(value)}`);
}

/** Convert a nullable `timestamptz` column to `string | null`. */
export function asIsoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : asIso(value);
}

/**
 * Serialize an embedding/centroid vector into the `pgvector` text literal
 * `[v0,v1,…]`. The driver binds this string to a `vector(1536)` parameter.
 */
export function serializeVector(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

/**
 * Parse a `pgvector` value into a `number[]`. The driver returns vectors as the
 * text form `[v0,v1,…]`; an already-parsed array is passed through. Returns
 * `null` for a null column.
 */
export function parseVector(value: unknown): number[] | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => asNumber(v));
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const inner = trimmed.replace(/^\[/, '').replace(/\]$/, '').trim();
    if (inner === '') return [];
    return inner.split(',').map((part) => asNumber(part.trim()));
  }
  throw new Error(`Expected a vector column value but received: ${String(value)}`);
}

/**
 * Build a `($1, $2, …)` placeholder list for `n` parameters, starting at
 * `start` (1-based). Used by IN-list and VALUES clauses. Never interpolates
 * values — only the positional placeholders.
 */
export function placeholders(count: number, start = 1): string {
  return Array.from({ length: count }, (_, i) => `$${start + i}`).join(', ');
}
