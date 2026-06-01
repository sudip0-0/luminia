// Mobile_App Signal_Collector durable buffer (Requirements 12.10, 12.11).
//
// Public surface:
//   - DurableSignalBuffer: capacity/eviction/idempotency logic (pure; storage-agnostic).
//   - SignalEventStore + types: the storage abstraction the buffer depends on.
//   - InMemorySignalEventStore: non-durable store for tests and as a fallback.
//   - SqliteSignalEventStore / openSignalEventStore: Expo SQLite-backed durable store.

export * from './types.js';
export * from './durable-buffer.js';
export * from './in-memory-store.js';
export * from './sqlite-store.js';
