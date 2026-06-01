-- 0007_emerging_and_crawl.sql
-- Emerging-topic detections and ingestion crawl bookkeeping.
--
-- Requirements: 14.7 (emerging topics), 5.3/5.4 (crawl state), 5.6/5.7 (failures).
-- Design: "PostgreSQL Schema (logical)" -> emerging_topic, crawl_state, crawl_failure.

-- emerging_topic: a topic detected as newly emerging for a user (Requirement 14.7).
CREATE TABLE IF NOT EXISTS emerging_topic (
  user_id     uuid NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  topic_id    uuid NOT NULL REFERENCES topic (id) ON DELETE CASCADE,
  detected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, topic_id)
);

-- crawl_state: the last successful crawl time per source. Drives the
-- "since last successful crawl, else 24h backfill" logic (Requirements 5.3, 5.4).
CREATE TABLE IF NOT EXISTS crawl_state (
  source                   content_source PRIMARY KEY,
  last_successful_crawl_at timestamptz
);

-- crawl_failure: an isolated, recorded crawl/processing failure (Requirements 5.6, 5.7).
CREATE TABLE IF NOT EXISTS crawl_failure (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source      content_source NOT NULL,
  error       text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crawl_failure_source_occurred_at_idx
  ON crawl_failure (source, occurred_at);
