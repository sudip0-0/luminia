// Uniform API error envelope and stable error codes.
//
// Mirrors the "Cross-cutting conventions" of the design's Error Handling
// section: every API error returns `{ error: { code, message, details? } }`
// with an appropriate HTTP status. `code` is a stable machine string; `details`
// carries per-field validation context but never echoes secrets
// (Requirements 7.1-area validation, 13.2, and the cross-cutting conventions).

/**
 * Stable, machine-readable error codes. These strings are part of the API
 * contract and must remain stable across releases so clients can branch on
 * them.
 */
export const ERROR_CODES = {
  /** Request failed input validation (e.g. bad field, out-of-range value). */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /** Authentication failed; intentionally generic to defeat enumeration. */
  AUTH_FAILED: 'AUTH_FAILED',
  /** The requested resource does not exist. */
  NOT_FOUND: 'NOT_FOUND',
  /** The request conflicts with existing state (e.g. duplicate email). */
  CONFLICT: 'CONFLICT',
  /** The actor is authenticated but not permitted to perform the action. */
  FORBIDDEN: 'FORBIDDEN',
  /** The actor has exceeded a rate limit. */
  RATE_LIMITED: 'RATE_LIMITED',
} as const;

/** A stable error code string (one of {@link ERROR_CODES}). */
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** The body of a single error. */
export interface ApiErrorBody {
  /** Stable machine-readable code. */
  code: ErrorCode;
  /** Human-readable message; safe to surface, never contains secrets. */
  message: string;
  /**
   * Optional per-field or contextual detail (e.g. which field failed
   * validation). Never echoes secrets.
   */
  details?: unknown;
}

/** The uniform error envelope returned by every API error. */
export interface ApiErrorEnvelope {
  error: ApiErrorBody;
}

/**
 * Construct a uniform error envelope. `details` is omitted from the envelope
 * when not provided.
 */
export function makeError(
  code: ErrorCode,
  message: string,
  details?: unknown
): ApiErrorEnvelope {
  const body: ApiErrorBody = { code, message };
  if (details !== undefined) {
    body.details = details;
  }
  return { error: body };
}
