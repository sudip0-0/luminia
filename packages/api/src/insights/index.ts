// Insights_Service module barrel — reading statistics, topic trends, emerging
// interests, and the feed-evolution narrative (Requirements 24, 25). This task
// implements the monthly aggregates and per-source breakdown (Requirements
// 24.1, 24.3, 24.8); topic breakdown/trends, emerging interests, the weights
// endpoint, and the narrative are added by separate tasks. See the design's
// "Insights_Service" section.

export * from './monthly.js';
export * from './topics.js';
export * from './emerging.js';
