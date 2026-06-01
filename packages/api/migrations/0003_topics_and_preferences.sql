-- 0003_topics_and_preferences.sql
-- Topic taxonomy, per-user topic weights, and per-user source toggles.
--
-- Requirements: 3.x (onboarding), 9.x (centroids), 25.x (muting).
-- Design: "PostgreSQL Schema (logical)" -> topic, user_topic, user_source.

-- topic: a node in the curiosity taxonomy. parent_id is a self reference.
-- centroid is a 1536-dim vector used by serendipity selection (Requirement 10.3).
CREATE TABLE IF NOT EXISTS topic (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug      text NOT NULL UNIQUE,
  label     text NOT NULL,
  parent_id uuid REFERENCES topic (id) ON DELETE SET NULL,
  color     text NOT NULL,
  icon_name text NOT NULL,
  centroid  vector(1536)
);

CREATE INDEX IF NOT EXISTS topic_parent_id_idx ON topic (parent_id);

-- user_topic: a user's weighted, possibly muted association with a topic.
-- weight in [0.0, 2.0]; source distinguishes onboarding vs inferred
-- (Requirements 3.6, 14.6, 25.x).
CREATE TABLE IF NOT EXISTS user_topic (
  user_id    uuid NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  topic_id   uuid NOT NULL REFERENCES topic (id) ON DELETE CASCADE,
  weight     numeric NOT NULL DEFAULT 1.0,
  source     user_topic_source NOT NULL,
  muted      boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, topic_id),
  CONSTRAINT user_topic_weight_range_chk CHECK (weight BETWEEN 0.0 AND 2.0)
);

CREATE INDEX IF NOT EXISTS user_topic_topic_id_idx ON user_topic (topic_id);

-- user_source: per-user enabled/disabled state for each content source
-- (Requirements 3.7, 4.4).
CREATE TABLE IF NOT EXISTS user_source (
  user_id uuid NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  source  content_source NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY (user_id, source)
);
