// @lumina/shared — shared domain types and utilities.
// Entry point: re-exports the domain types, ranking value types, request/
// response envelopes, and the uniform error envelope with stable error codes.

export const SHARED_PACKAGE_NAME = '@lumina/shared';

export * from './domain.js';
export * from './ranking.js';
export * from './ranking-engine.js';
export * from './errors.js';
export * from './envelopes.js';
export * from './validators.js';
