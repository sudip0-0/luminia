// Repository layer barrel.
//
// The repository/data-access layer provides typed query functions over the
// PostgreSQL schema (see `packages/api/migrations`) for every service: users,
// auth (oauth identities, refresh tokens), topics and preferences, articles and
// their topic associations, user embeddings, feed events, library saves,
// collections, emerging topics, and crawl bookkeeping.
//
// Every function depends on the narrow {@link Queryable} interface rather than
// on `pg` directly, so repositories are unit-testable with an in-memory fake
// and a live `pg.Pool` satisfies the interface via {@link fromPool}. All
// queries are parameterized; no value is ever interpolated into a SQL string.

export * from './queryable.js';
export * from './mappers.js';
export * from './types.js';
export * from './rows.js';

export * from './users.repository.js';
export * from './oauth-identities.repository.js';
export * from './refresh-tokens.repository.js';
export * from './topics.repository.js';
export * from './user-topics.repository.js';
export * from './user-sources.repository.js';
export * from './articles.repository.js';
export * from './article-topics.repository.js';
export * from './user-embeddings.repository.js';
export * from './feed-events.repository.js';
export * from './saved-articles.repository.js';
export * from './collections.repository.js';
export * from './emerging-topics.repository.js';
export * from './crawl.repository.js';
