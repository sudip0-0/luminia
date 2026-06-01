# Implementation Plan: Lumina

## Overview

This plan implements Lumina, the anti-doomscroll knowledge feed, in TypeScript across three tiers described in the design: a Fastify-based Backend API, a React Native (Expo) Mobile_App, and an Ingestion & Jobs tier. The work proceeds bottom-up: shared types and data stores first, then pure logic (validators, Ranking_Engine, signal/session logic) that is cheap to property-test, then the request-handling services, the ingestion pipeline, the learning job, and finally the mobile UI and end-to-end wiring.

Property-based tests use `fast-check` under the project test runner (Vitest/Jest in single-run mode) at a minimum of 100 generated iterations each, and are annotated with `// Feature: lumina, Property {number}: ...`. Each of the 51 correctness properties is implemented by exactly one property-based test task. Test sub-tasks are marked optional with `*`.

Services are organized into small modules (for example, `auth/tokens.ts`, `auth/register.ts`, `feed/assembly.ts`, `feed/tabs.ts`) so that independent tasks can progress without colliding on the same file.

## Status

All implementation tasks are complete and verified (clean `tsc --build`, ESLint, and `vitest run`: 925+ tests passing). All 51 correctness properties have an annotated property-based test. The only deliberately-skipped tasks are two optional (`*`) tests that require infrastructure not available in this environment: task 14.3 (a live pgvector integration test) and task 27.7 (React Native snapshot/interaction tests, which need a RN test renderer). Task 20.4's Typesense integration test exists but is runtime-skipped unless a live Typesense index is configured.

## Tasks

- [x] 1. Set up project structure, shared types, and tooling
  - [x] 1.1 Initialize the monorepo workspaces and toolchain
    - Create `packages/shared`, `packages/api`, `packages/jobs`, and `apps/mobile` workspaces
    - Configure TypeScript, ESLint, the test runner (Vitest or Jest in `--run`/single-execution mode), and add `fast-check` as a dev dependency
    - Add Fastify to `api`, Expo to `mobile`, and BullMQ to `jobs`
    - _Requirements: (foundational; supports all)_

  - [x] 1.2 Define shared domain types
    - Implement `Source`, `Difficulty`, `Depth`, `FeedEventType`, `Article`, `SummarizerOutput`, `RankingComponents`, `RankingWeights`, and request/response envelope types in `packages/shared`
    - Define the uniform error envelope `{ error: { code, message, details? } }` and stable error codes
    - _Requirements: 5.1, 7.1, 9.1, 12 (FeedEventType set), 13.2_

- [x] 2. Build the data layer and external store clients
  - [x] 2.1 Create the PostgreSQL schema and pgvector migrations
    - Write migrations for `user`, `oauth_identity`, `refresh_token`, `topic`, `user_topic`, `user_source`, `article`, `article_topic`, `user_embedding`, `feed_event`, `saved_article`, `collection`, `collection_article`, `emerging_topic`, `crawl_state`, `crawl_failure`
    - Enable the `pgvector` extension and define `vector(1536)` columns and the `url_hash` unique constraint
    - _Requirements: 6.5, 7.5, 9.x (embeddings), 13.1_

  - [x] 2.2 Implement the Redis client and key helpers
    - Provide helpers for `denylist:jti:{jti}`, `login:fail:{userId}`, `lockout:{userId}`, `feedver:{feedVersion}:returned`, and `notif:last:{userId}` with their TTLs
    - _Requirements: 2.1, 2.5, 2.7, 8.2, 18.2_

  - [x] 2.3 Implement the Typesense client and `articles` collection schema
    - Define indexed fields (`title`, `summary`, `full_text`, `source` facet, `topic_slugs[]` facet, `read_time_minutes` range, `published_at` range)
    - _Requirements: 20.4, 20.7_

  - [x] 2.4 Implement the repository/data-access layer
    - Provide typed query functions over the PostgreSQL schema for users, topics, articles, events, saves, collections, and embeddings used by all services
    - _Requirements: 6.5, 8.x, 13.1, 21.x, 22.x_

- [x] 3. Implement pure input validators
  - [x] 3.1 Implement the validator functions
    - Implement `validateEmail`, `validatePassword`, `validateDailyGoal`, `validateDepth`, `validateDisplayName`, and collection-name validation as pure functions reused by registration, onboarding, and profile update
    - _Requirements: 1.3, 1.4, 1.7, 1.8, 3.4, 22.1, 26.2, 26.3_

  - [x] 3.2 Write property test for the input validators
    - **Property 1: Input validators accept exactly the allowed ranges**
    - **Validates: Requirements 1.3, 1.4, 1.7, 1.8, 3.4, 22.1, 26.2, 26.3**

- [x] 4. Implement Auth_Service
  - [x] 4.1 Implement token issuance, verification, and the denylist
    - Implement `issueAccessToken` (15 min, unique `jti`), `issueRefreshToken` (30 days, hashed at rest), access-token verification middleware, and the Redis `jti` denylist check
    - _Requirements: 2.1, 2.5, 2.6, 26.4_

  - [x] 4.2 Implement registration and OAuth registration
    - Create accounts from valid email/password, reject duplicate email with conflict, apply default Daily_Goal (15) and Depth_Preference (balanced) when omitted, and link-or-create google/apple identities while rejecting unsupported/unverifiable providers
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9_

  - [x] 4.3 Implement login, refresh, logout, and account lockout
    - Issue tokens on valid login, return a generic auth error otherwise, refresh access tokens, revoke both tokens on logout, and lock an account for 15 minutes after 5 failures within a 15-minute sliding window
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.7_

  - [x] 4.4 Implement profile read and update
    - Return display name, avatar, Depth_Preference, and Daily_Goal; persist validated updates and reject invalid fields without mutating stored state
    - _Requirements: 26.1, 26.2, 26.3, 26.4_

  - [x] 4.5 Write property test for indistinguishable authentication failures
    - **Property 2: Authentication failures are indistinguishable**
    - **Validates: Requirements 2.2, 2.4, 2.6**

  - [x] 4.6 Write property test for account lockout threshold
    - **Property 3: Account lockout triggers exactly at the threshold within the window**
    - **Validates: Requirements 2.7**

  - [x] 4.7 Write unit tests for auth happy paths
    - Token expiries, refresh issuing a new access token, logout invalidating both tokens, default goal/depth, OAuth link-vs-create branches with a mocked provider
    - _Requirements: 1.1, 1.5, 1.9, 2.1, 2.3, 2.5_

- [x] 5. Implement Onboarding_Service
  - [x] 5.1 Implement the taxonomy endpoint
    - Return each Topic with slug, label, parent reference, color, and icon name
    - _Requirements: 3.1_

  - [x] 5.2 Implement onboarding completion (all-or-nothing)
    - Validate topic count (3-20), topic existence, depth, and Daily_Goal; persist each distinct topic with `source = onboarding` and `weight = 1.0`, store depth and Daily_Goal, persist per-source enabled state; persist nothing on any validation failure
    - _Requirements: 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

  - [x] 5.3 Write property test for onboarding persistence
    - **Property 4: Onboarding persistence is all-or-nothing and normalized**
    - **Validates: Requirements 3.2, 3.3, 3.4, 3.5, 3.6**

  - [x] 5.4 Write unit tests for onboarding and profile happy paths
    - Onboarding success persisting depth/goal/sources and profile read shape
    - _Requirements: 3.6, 3.7, 26.1_

- [x] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Implement ingestion deduplication, quality scoring, read time, and storage
  - [x] 7.1 Implement the Deduplicator
    - Compute the SHA-256 hash of the normalized URL and discard articles whose hash collides with a stored article, recording a rejected duplicate
    - _Requirements: 6.1, 6.2_

  - [x] 7.2 Write property test for URL-hash deduplication
    - **Property 5: URL-hash deduplication discards exactly colliding articles**
    - **Validates: Requirements 6.1, 6.2**

  - [x] 7.3 Implement the Quality_Scorer
    - Assign a quality score in [0.0, 1.0] from content length, reading level, and source tier; reject and block storage below 0.3
    - _Requirements: 6.3, 6.4_

  - [x] 7.4 Write property test for quality scoring
    - **Property 6: Quality score is bounded and gates storage**
    - **Validates: Requirements 6.3, 6.4**

  - [x] 7.5 Implement the Read_Time_Estimator and storage completeness gate
    - Compute a whole-minute read time with a minimum of 1; refuse storage unless URL, source, title, summary, cleaned full text, quality score >= 0.3, a 1536-dim embedding, and read time >= 1 are present; persist complete articles and index them into Typesense
    - _Requirements: 6.5, 6.6, 7.5_

  - [x] 7.6 Write property test for the stored-article completeness invariant
    - **Property 7: Stored articles satisfy the completeness invariant**
    - **Validates: Requirements 6.5, 6.6, 7.5**

- [x] 8. Implement summarization and embedding
  - [x] 8.1 Implement the Summarizer with bounded retries
    - Call the Claude API for a 2-3 sentence summary, 1-4 taxonomy tags, difficulty, and read time 1-120; validate the JSON structure, associate tags as topics with confidence in [0,1], and retry malformed responses up to 3 attempts leaving the article unsummarized on exhaustion
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [x] 8.2 Write property test for Summarizer output bounds
    - **Property 8: Summarizer output respects all bounds**
    - **Validates: Requirements 7.1, 7.2**

  - [x] 8.3 Implement the Embedder with bounded retries
    - Generate a 1536-dim embedding before storage, retry up to 3 attempts, block storage until embedding succeeds, and skip storage with a logged failure on exhaustion
    - _Requirements: 7.5, 7.6, 7.7_

  - [x] 8.4 Write property test for bounded pipeline retries and terminal state
    - **Property 9: Pipeline retries are bounded and end in a consistent terminal state**
    - **Validates: Requirements 7.3, 7.4, 7.6, 7.7**

- [x] 9. Implement crawlers, pipeline orchestration, and the scheduler
  - [x] 9.1 Implement the Crawler interface and six source crawlers
    - Fetch items published since the last successful crawl per source, or within a 24-hour backfill window on first run, updating `crawl_state`
    - _Requirements: 5.1, 5.3, 5.4_

  - [x] 9.2 Implement pipeline orchestration with per-source failure isolation
    - Run each item through Deduplicator -> Quality_Scorer -> Summarizer -> Embedder -> Read_Time_Estimator -> storage in sequence; on a >30s timeout or error response record a `crawl_failure` and continue remaining sources, continuing even if recording the failure fails
    - _Requirements: 5.2, 5.6, 5.7_

  - [x] 9.3 Implement the Scheduler intervals
    - Register Wikipedia hourly, Hacker News every 15 minutes, and Medium/arXiv/MIT News/Quanta every 6 hours as repeatable jobs
    - _Requirements: 5.5_

  - [x] 9.4 Write integration tests for ingestion and source isolation
    - Verify end-to-end store against fixtures and that one timing-out source does not block the others (pipeline.test.ts)
    - _Requirements: 5.2, 5.6, 5.7_

- [x] 10. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Implement the Ranking_Engine (pure, no I/O)
  - [x] 11.1 Implement the component functions and weighted-sum score
    - Implement `relevance` (cosine normalized via `(cos+1)/2`, with onboarding topic-match fallback), `recency` (`0.5 ^ (age/24)`), `novelty`, `quality`, `diversityBonus` ([0,0.20], component capped at 1.0), serendipity, and `scoreArticle` (weighted sum clamped to [0,1]) with default weights 0.35/0.20/0.20/0.15/0.05/0.05
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.7_

  - [x] 11.2 Write property test for bounded score and components
    - **Property 15: Ranking score and every component are bounded in [0,1]**
    - **Validates: Requirements 9.1, 9.2, 9.7**

  - [x] 11.3 Write property test for recency decay
    - **Property 16: Recency decay is monotonic and anchored**
    - **Validates: Requirements 9.3**

  - [x] 11.4 Write property test for diversity bonus bounds
    - **Property 18: Diversity bonus is bounded and the component is capped**
    - **Validates: Requirements 9.5**

  - [x] 11.5 Implement bandit weight tuning with re-normalization
    - Apply per-topic relevance adjustments in [0.0, 0.15] for engaged topics and re-normalize the six weights to sum to 1.0
    - _Requirements: 9.6_

  - [x] 11.6 Write property test for weight normalization
    - **Property 17: Component weights always sum to 1.0**
    - **Validates: Requirements 9.4, 9.6**

  - [x] 11.7 Implement serendipity article selection
    - Select an article from a topic the user has never interacted with, otherwise from the topic whose centroid is farthest from the User_Embedding
    - _Requirements: 10.2, 10.3_

  - [x] 11.8 Write property test for serendipity selection
    - **Property 20: Serendipity selection follows the never-interacted-then-farthest rule**
    - **Validates: Requirements 10.2, 10.3**

- [x] 12. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 13. Implement Feed_Service assembly, pagination, tabs, and serendipity injection
  - [x] 13.1 Implement candidate resolution and exclusions
    - Build the candidate pool excluding muted-topic articles and prior-`skip` articles, and restrict to a topic when the tab is a slug
    - _Requirements: 8.4, 8.6, 25.2_

  - [x] 13.2 Write property test for topic-tab restriction
    - **Property 12: Topic-tab feeds are restricted to the topic**
    - **Validates: Requirements 8.4**

  - [x] 13.3 Write property test for excluded articles
    - **Property 14: Excluded articles never appear in the feed**
    - **Validates: Requirements 8.6, 25.2**

  - [x] 13.4 Implement scoring, ordering, paging, and feed-version tracking
    - Score candidates via the Ranking_Engine, sort descending, page to 1-20 cards, emit a `nextCursor` and `feedVersion`, and record returned IDs under the feed version so cursor pages never repeat; reject malformed/expired/unknown cursors and invalid tabs without returning articles
    - _Requirements: 8.1, 8.2, 8.3, 8.7, 8.8_

  - [x] 13.5 Write property test for bounded feed pages
    - **Property 10: Feed pages are bounded in size**
    - **Validates: Requirements 8.1**

  - [x] 13.6 Write property test for non-repeating pages within a feed version
    - **Property 11: A feed version never repeats an article across pages**
    - **Validates: Requirements 8.2**

  - [x] 13.7 Implement serendipity injection into the feed sequence
    - Insert exactly one Serendipity_Card at every position that is a multiple of 10
    - _Requirements: 10.1_

  - [x] 13.8 Write property test for serendipity injection cadence
    - **Property 19: Serendipity cards are injected at every 10th position**
    - **Validates: Requirements 10.1**

  - [x] 13.9 Implement active feed tabs
    - Return `foryou` followed by 1-10 topic tabs ordered by descending weight, excluding weight-0 topics
    - _Requirements: 8.5_

  - [x] 13.10 Write property test for active tabs filtering and ordering
    - **Property 13: Active tabs are filtered and ordered**
    - **Validates: Requirements 8.5**

  - [x] 13.11 Write unit tests for cursor/tab error branches and not-found article detail
    - Invalid cursor (8.7), invalid tab (8.8) in assembly.test.ts; nonexistent article detail (20.2) in detail.test.ts
    - _Requirements: 8.7, 8.8, 20.2_

- [x] 14. Implement article detail and related articles
  - [x] 14.1 Implement article detail and related-article retrieval
    - Return full article detail with related articles; return up to 5 distinct articles ordered by descending cosine similarity excluding the source via the pgvector `<=>` operator; return `[]` when none remain; return detail without related articles when related retrieval fails; return not-found when the source article is missing
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 20.1, 20.3_

  - [x] 14.2 Write property test for related-articles set
    - **Property 21: Related articles are distinct, capped, ordered, and exclude the source**
    - **Validates: Requirements 11.1, 11.2, 11.3**

  - [ ] 14.3 Write integration test for pgvector neighbour ordering *(SKIPPED: needs a live seeded pgvector database)*
    - Verify related-articles and serendipity centroid queries return correctly ordered neighbours against a seeded database
    - _Requirements: 11.1, 10.3_

- [x] 15. Implement topic muting
  - [x] 15.1 Implement mute/unmute persistence
    - Persist muted/unmuted state idempotently, exclude muted-topic articles from current and subsequent sessions, and return not-found when the topic is not associated with the user
    - _Requirements: 25.2, 25.3, 25.4, 25.5, 25.6_

  - [x] 15.2 Write property test for mute round-trip and idempotency
    - **Property 45: Mute state round-trips and is idempotent**
    - **Validates: Requirements 25.3, 25.4, 25.5**

- [x] 16. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 17. Implement Feed_Event_Service (event ingestion)
  - [x] 17.1 Implement batch ingestion with validation, idempotency, and atomic over-limit rejection
    - Reject batches over 500 atomically; validate each event type against the allowed set, persisting valid events and reporting rejected ones; de-duplicate by `clientEventId`; return `{ persisted, rejected, duplicates }` reconciling to batch size
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5_

  - [x] 17.2 Write property test for idempotent ingestion
    - **Property 26: Event ingestion is idempotent on clientEventId**
    - **Validates: Requirements 13.4**

  - [x] 17.3 Write property test for partial validation accounting
    - **Property 27: Partial validation persists valid events and accounts for all events**
    - **Validates: Requirements 13.1, 13.2, 13.3**

  - [x] 17.4 Write property test for atomic over-limit rejection
    - **Property 28: Over-limit batches are rejected atomically**
    - **Validates: Requirements 13.5**

  - [x] 17.5 Implement mute_topic event recording by highest-confidence topic
    - When a mute_topic event is recorded for an article, target the topic with the highest association confidence for that article
    - _Requirements: 23.4_

  - [x] 17.6 Write property test for highest-confidence mute-topic selection
    - **Property 46: Mute-topic selects the highest-confidence topic**
    - **Validates: Requirements 23.4**

- [x] 18. Implement the Preference_Model_Updater (pure learning job)
  - [x] 18.1 Implement event-type signal weighting
    - Compute the interest signal as the weighted sum of event types (impression 0.05, dwell 0.15, expand 0.35, scroll_depth 0.10 x clamped scrollProportion, save 0.50, unsave 0.0, share 0.60, link_out 0.45, skip -0.20, session_end 0.0, mute_topic -1.00)
    - _Requirements: 14.3_

  - [x] 18.2 Write property test for event-type signal weighting
    - **Property 29: Event-type signal weighting is deterministic and correctly scaled**
    - **Validates: Requirements 14.3**

  - [x] 18.3 Implement the recency-weighted centroid embedding update
    - Evaluate events within the 30-day window, build a recency-weighted centroid over engaged articles (net signal > 0) where a later most-recent event yields a strictly greater weight, and leave the model unchanged when the window has no events
    - _Requirements: 14.2, 14.4, 14.5, 14.9_

  - [x] 18.4 Write property test for the recency-weighted centroid and tie-break
    - **Property 30: The User_Embedding is the recency-weighted centroid of engaged articles, and recency strictly breaks ties**
    - **Validates: Requirements 14.4, 14.5**

  - [x] 18.5 Write property test for empty-window no-op
    - **Property 33: An empty 30-day window leaves the model unchanged**
    - **Validates: Requirements 14.9**

  - [x] 18.6 Implement topic-weight recomputation and emerging-topic detection
    - Recompute each topic weight as cosine similarity to the topic centroid clamped to [0,2]; record a topic as emerging when `r > 1.2*p` or (`p <= 0` and `r > 0`); record none emerging when both 7-day windows are empty
    - _Requirements: 14.6, 14.7, 14.8_

  - [x] 18.7 Write property test for topic-weight clamping
    - **Property 31: Recomputed topic weights are clamped to [0,2]**
    - **Validates: Requirements 14.6**

  - [x] 18.8 Write property test for emerging-topic classification
    - **Property 32: Emerging-topic classification follows the growth rule**
    - **Validates: Requirements 14.7**

  - [x] 18.9 Register the 6-hour preference job
    - Schedule the Preference_Model_Updater to run every 6 hours
    - _Requirements: 14.1_

- [x] 19. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 20. Implement Search_Service
  - [x] 20.1 Implement query validation and conjunctive filtering
    - Perform the search only when the trimmed query length is in [1,200], rejecting empty/whitespace-only/oversized queries; apply source, topic, read-time, and date-range filters conjunctively; return matches by descending relevance and an empty set on no match
    - _Requirements: 20.4, 20.5, 20.6, 20.7_

  - [x] 20.2 Write property test for search query validation
    - **Property 38: Search query validation rejects empty, whitespace-only, and oversized queries**
    - **Validates: Requirements 20.5**

  - [x] 20.3 Write property test for conjunctive filter application
    - **Property 39: Search filters are applied conjunctively**
    - **Validates: Requirements 20.7**

  - [x] 20.4 Write integration test for Typesense indexing and ordering
    - Verify indexing on store and descending full-text relevance ordering with conjunctive filters against a live index (present; runtime-skipped unless a live Typesense index is configured)
    - _Requirements: 20.4, 20.7_

- [x] 21. Implement Library_Service (saves and collections)
  - [x] 21.1 Implement idempotent save, unsave, read-state, and listing
    - Save adds with read state `unread` and one `save` event (idempotent on re-save); unsave removes and records `unsave` (error when not saved); persist read state; return at most 50 per page filterable by read state and source
    - _Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6_

  - [x] 21.2 Write property test for idempotent saving
    - **Property 41: Saving is idempotent**
    - **Validates: Requirements 21.1, 21.5**

  - [x] 21.3 Write property test for page-bounded, filter-consistent listing
    - **Property 42: The saved-articles list is page-bounded and filter-consistent**
    - **Validates: Requirements 21.4**

  - [x] 21.4 Implement collection CRUD with ownership and save-precondition enforcement
    - Create/update/delete collections; add saved articles; return paginated contents; reject adding unsaved articles; reject mutations on another user's collection with an authorization error; delete preserves underlying saved articles
    - _Requirements: 22.1, 22.2, 22.3, 22.4, 22.5, 22.6, 22.7_

  - [x] 21.5 Write property test for collection deletion preserving saved articles
    - **Property 43: Deleting a collection preserves the underlying saved articles**
    - **Validates: Requirements 22.4**

  - [x] 21.6 Write property test for collection mutation preconditions and ownership
    - **Property 44: Collection mutations enforce save-precondition and ownership**
    - **Validates: Requirements 22.6, 22.7**

- [x] 22. Implement Insights_Service
  - [x] 22.1 Implement monthly aggregates and per-source breakdown
    - Compute articles read this month, quality reading minutes excluding skip events, newly discovered topics this month, and per-source reading-time breakdown; return zero counts and empty breakdowns with no history
    - _Requirements: 24.1, 24.3, 24.8_

  - [x] 22.2 Write property test for monthly aggregates
    - **Property 47: Insights monthly aggregates are computed from in-month events**
    - **Validates: Requirements 24.1, 24.3**

  - [x] 22.3 Implement topic breakdown trend classification and weights endpoint
    - Sort topics by descending weight, label growing/fading/steady by the 7-day signal change thresholds, and return per-topic weight and muted state
    - _Requirements: 24.2, 25.1_

  - [x] 22.4 Write property test for topic breakdown classification and ordering
    - **Property 48: Topic breakdown is trend-classified and weight-ordered**
    - **Validates: Requirements 24.2**

  - [x] 22.5 Implement emerging interests, acceptance, and narrative
    - Return up to 3 emerging topics excluding already-added topics; accepting an emerging topic adds it with `source = inferred` and removes it from the list, while accepting a non-emerging topic errors and leaves state unchanged; return a 1-3 sentence narrative, or an insufficient-history narrative when there is no reading history
    - _Requirements: 24.4, 24.5, 24.6, 24.7, 24.9, 24.10_

  - [x] 22.6 Write property test for emerging interests cap and exclusion
    - **Property 49: Emerging interests are capped and exclude already-added topics**
    - **Validates: Requirements 24.4**

  - [x] 22.7 Write property test for emerging-topic acceptance transition
    - **Property 50: Accepting an emerging topic transitions it into the user's topics**
    - **Validates: Requirements 24.5, 24.6**

  - [x] 22.8 Write property test for the bounded narrative
    - **Property 51: The feed-evolution narrative is bounded to 1-3 sentences**
    - **Validates: Requirements 24.7**

  - [x] 22.9 Write unit tests for no-history insights branches
    - Zero counts, empty breakdowns, and insufficient-history narrative (monthly.test.ts, emerging.test.ts)
    - _Requirements: 24.8, 24.9, 24.10_

- [x] 23. Implement Notification_Service
  - [x] 23.1 Implement default-off delivery with the 24-hour rate limit
    - Default push to disabled at account creation; never send while disabled; send at most one push per rolling 24 hours when enabled using the fixed copy "Your curiosity feed has new picks."; expose the preferences toggle
    - _Requirements: 18.1, 18.2, 18.3, 18.4_

  - [x] 23.2 Write property test for notification hygiene
    - **Property 36: Notification delivery respects default-off, suppression, and the 24-hour rate limit**
    - **Validates: Requirements 18.1, 18.2, 18.4**

- [x] 24. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 25. Implement Mobile_App Signal_Collector and durable buffer
  - [x] 25.1 Implement the durable buffer with oldest-first eviction
    - Persist events in Expo SQLite with `clientEventId`, retain unacknowledged events across restarts, and evict the oldest event when an insertion would exceed 1000
    - _Requirements: 12.10, 12.11_

  - [x] 25.2 Write property test for buffer capacity and eviction
    - **Property 25: The local buffer enforces capacity by evicting oldest-first**
    - **Validates: Requirements 12.11**

  - [x] 25.3 Implement visibility, dwell, skip, expand, scroll-depth, and link-out capture
    - Record impressions at >=50% visibility, classify skip (<1500ms) vs a single dwell event (>=1500ms) with tracked duration, record expand and link_out, and emit a scroll_depth event when the max scrolled proportion rises by >=0.25
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7_

  - [x] 25.4 Write property test for dwell/skip classification
    - **Property 22: Dwell duration classifies into exactly one of skip or dwell**
    - **Validates: Requirements 12.4, 12.5**

  - [x] 25.5 Write property test for scroll-depth emission
    - **Property 23: Scroll-depth events fire only on a 0.25 increase in maximum depth**
    - **Validates: Requirements 12.6**

  - [x] 25.6 Implement batched transmission with retry
    - Flush every 30 seconds in batches of at most 200, treat no acknowledgement within 10 seconds as failed, retain and retry unacknowledged events
    - _Requirements: 12.8, 12.9_

  - [x] 25.7 Write property test for transmission batch size
    - **Property 24: Transmission batches never exceed 200 events**
    - **Validates: Requirements 12.8**

- [x] 26. Implement Session_Manager (anti-doomscroll logic)
  - [x] 26.1 Implement soft feed end and the daily-goal arc as pure functions
    - Track viewed-card count, present the session-end screen at 30 cards and prevent further loading, reset to 0 on "Keep going"; compute the arc as `min(accumulatedMinutes / dailyGoal, 1.0)` updated at most once per 60 seconds, stay full while at/above goal without wrapping, and reset at local midnight
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 16.1, 16.2, 16.3, 16.4, 16.5_

  - [x] 26.2 Write property test for soft feed end
    - **Property 34: Soft feed end triggers at 30 cards and resets on continue**
    - **Validates: Requirements 15.2, 15.4**

  - [x] 26.3 Write property test for the daily-goal arc
    - **Property 35: The daily-goal arc is the capped progress ratio**
    - **Validates: Requirements 16.1, 16.5**

- [x] 27. Implement Mobile_App screens, navigation, and search history
  - [x] 27.1 Implement onboarding flow screens with gating
    - Route un-onboarded users to onboarding; disable advance until >=3 topics selected and exactly one depth selected; enable all six sources by default and retain them on skip; submit selections and load the first feed, preserving onboarding state if feed assembly fails
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_

  - [x] 27.2 Implement the feed screen, card rendering, and gesture interactions
    - Render cards showing read-time and source with no engagement counts and no media autoplay; show the "Something new" pill on serendipity cards; wire swipe-left skip, 500ms long-press action sheet (save/share/mute/open source), and short-tap open-in-reader, recording the corresponding events
    - _Requirements: 10.4, 17.1, 17.2, 17.3, 17.4, 23.1, 23.2, 23.3, 23.4, 23.5, 23.6_

  - [x] 27.3 Implement the Reader with related-articles gating
    - Render cleaned full text with Lumina typography, exclude ads, apply dark mode, report scroll depth to the Signal_Collector, present "Go deeper" with min(n,5) related articles when n>=3 and omit it when n<3, and show an external-browser control when an article has no stored full text
    - _Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6_

  - [x] 27.4 Write property test for the "Go deeper" gating
    - **Property 37: The "Go deeper" section is gated by the related-count threshold**
    - **Validates: Requirements 19.4, 19.5**

  - [x] 27.5 Implement search, library, and insights screens with local search history
    - Wire the search screen to Search_Service and store non-empty queries in local history (<=50 unique, oldest-evicted, recency-ordered); render library/collections and insights screens
    - _Requirements: 20.8, 21.4, 22.5, 24.1, 24.2, 24.4_

  - [x] 27.6 Write property test for bounded, unique, recency-ordered search history
    - **Property 40: Search history is bounded, unique, and recency-ordered**
    - **Validates: Requirements 20.8**

  - [ ] 27.7 Write snapshot and interaction tests for card, reader, and onboarding presentation *(SKIPPED: needs a React Native test renderer not configured in this environment)*
    - Card omits engagement counts and shows read-time/source; media never autoplays; onboarding gating; dark-mode/ad-free reader; serendipity pill
    - _Requirements: 4.2, 4.3, 4.4, 4.5, 10.4, 17.1, 17.2, 17.3, 17.4, 19.1, 19.2_

- [x] 28. Integration and end-to-end wiring
  - [x] 28.1 Register all API routes and middleware
    - Mount Auth, Onboarding, Feed, Feed_Event, Library, Search, Insights, and Notification routes behind the access-token middleware (public routes excepted) with the uniform error envelope; Feed assembly and Search mount when their Redis/Typesense clients are injected
    - _Requirements: 2.6, 8.1, 13.1, 20.4, 21.1, 24.1, 26.4_

  - [x] 28.2 Wire the Mobile_App to the API
    - Connect onboarding, feed, reader, library, search, and insights screens to their endpoints with transparent token refresh on 401
    - _Requirements: 2.3, 4.6, 8.1, 19.4, 20.4, 21.1, 24.1_

  - [x] 28.3 Write end-to-end smoke test
    - register -> onboard -> load first feed -> record events -> run preference update -> reload feed, asserting the flow completes and the feed reflects skips/mutes
    - _Requirements: 4.6, 8.6, 12.8, 14.1, 25.2_

  - [x] 28.4 Write smoke test for scheduler registrations
    - Verify Wikipedia hourly, Hacker News every 15 minutes, the rest every 6 hours, and the Preference_Model_Updater every 6 hours
    - _Requirements: 5.5, 14.1_

- [x] 29. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP; they are test sub-tasks (property, unit, integration, snapshot, and smoke tests).
- Each task references specific requirements (granular clauses) for traceability.
- Each of the 51 correctness properties is implemented by exactly one property-based test sub-task, annotated with its property number and the requirements clause it validates, and placed close to the implementation it checks.
- Property-based tests use `fast-check` at a minimum of 100 generated iterations and are tagged `// Feature: lumina, Property {number}: ...`.
- Checkpoints provide incremental validation at natural boundaries (pure logic, ingestion, ranking, services, client).
- The pure Ranking_Engine and Preference_Model_Updater are the highest-value PBT targets and are tested in isolation from I/O.
- **Deliberately skipped** (require infrastructure unavailable in this environment): 14.3 (live pgvector integration test) and 27.7 (React Native snapshot/interaction tests). Task 20.4's Typesense integration test exists but is runtime-skipped unless a live index is configured. All other tasks — including all 51 property-based tests — are implemented and pass.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["2.1", "2.2", "2.3", "3.1"] },
    { "id": 3, "tasks": ["2.4", "3.2", "11.1", "25.1", "26.1"] },
    { "id": 4, "tasks": ["4.1", "5.1", "7.1", "7.3", "8.1", "8.3", "11.2", "11.3", "11.4", "11.5", "18.1", "20.1", "23.1", "25.2", "25.3", "26.2", "26.3"] },
    { "id": 5, "tasks": ["4.2", "4.3", "4.4", "5.2", "7.2", "7.4", "7.5", "8.2", "8.4", "9.1", "11.6", "11.7", "13.1", "14.1", "15.1", "17.1", "18.2", "18.3", "20.2", "20.3", "20.4", "21.1", "22.1", "22.3", "23.2", "25.4", "25.5", "25.6"] },
    { "id": 6, "tasks": ["4.5", "4.6", "4.7", "5.3", "5.4", "7.6", "9.2", "9.3", "11.8", "13.2", "13.3", "13.4", "13.9", "14.2", "14.3", "15.2", "17.2", "17.3", "17.4", "17.5", "18.4", "18.5", "18.6", "21.2", "21.3", "21.4", "22.2", "22.4", "22.9", "25.7"] },
    { "id": 7, "tasks": ["9.4", "13.5", "13.6", "13.7", "13.10", "17.6", "18.7", "18.8", "18.9", "21.5", "21.6", "22.5", "27.1"] },
    { "id": 8, "tasks": ["13.8", "13.11", "22.6", "22.7", "22.8", "27.2", "27.3", "27.5", "28.1", "28.4"] },
    { "id": 9, "tasks": ["27.4", "27.6", "27.7", "28.2"] },
    { "id": 10, "tasks": ["28.3"] }
  ]
}
```
