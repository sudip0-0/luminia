// Feed_Service module barrel.
//
// Assembles paginated, ranked feeds (design's "Feed_Service" section,
// Requirements 8, 9, 10, 25). Exposes candidate resolution and exclusions
// (step 1 of `assembleFeed`) plus scoring, ordering, paging, and feed-version
// tracking (steps 2-4); serendipity injection and tabs are added by later tasks.

export * from './candidates.js';
export * from './assembly.js';
export * from './serendipity.js';
