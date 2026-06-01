// Feed_Event_Service module barrel — batched event ingestion (Requirement 13).
//
// Exposes the batch-size constant, the injected dependency interface, the
// discriminated ingestion result type, and the `ingestBatch` service.

export * from './ingest.js';
// mute_topic target resolution by highest-confidence topic (Requirement 23.4).
export * from './mute-topic.js';
