-- 0004_articles.sql
-- Ingested content items, their topic associations, and per-user embeddings.
--
-- Requirements: 6.3, 6.4, 6.5, 6.6, 7.x (summaries, embeddings), 9.x.
-- Design: "PostgreSQL Schema (logical)" -> article, article_topic, user_embedding.

-- article: a single ingested content item.
-- embedding is a 1536-dim vector, required before a complete article is stored
-- (Requirement 7.5); url_hash is the SHA-256 of the normalized URL and is the
-- deduplication key (Requirements 6.1, 6.2).
CREATE TABLE IF NOT EXISTS article (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url                  text NOT NULL,
  -- SHA-256 hex digest is 64 chars; UNIQUE enforces dedup (Requirement 6.2).
  url_hash             char(64) NOT NULL,
  source               content_source NOT NULL,
  title                text NOT NULL,
  -- null while unsummarized (Requirement 7.3).
  summary              text,
  -- cleaned full text; null => reader shows the external link.
  full_text            text,
  -- 1536-dim embedding; null until embedding succeeds (Requirement 7.5).
  embedding            vector(1536),
  -- quality score in [0.0, 1.0]; >= 0.3 to be stored (Requirements 6.3, 6.4).
  quality_score        numeric NOT NULL,
  difficulty           difficulty,
  -- whole minutes, >= 1 (Requirement 6.6).
  read_time_minutes    integer NOT NULL,
  summarization_status summarization_status NOT NULL DEFAULT 'pending',
  published_at         timestamptz NOT NULL,
  ingested_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT article_url_hash_key UNIQUE (url_hash),
  CONSTRAINT article_url_hash_len_chk CHECK (char_length(url_hash) = 64),
  CONSTRAINT article_quality_score_range_chk CHECK (quality_score BETWEEN 0.0 AND 1.0),
  CONSTRAINT article_read_time_min_chk CHECK (read_time_minutes >= 1)
);

CREATE INDEX IF NOT EXISTS article_source_idx ON article (source);
CREATE INDEX IF NOT EXISTS article_published_at_idx ON article (published_at);

-- article_topic: confidence-weighted topic tags for an article (Requirement 7.2).
CREATE TABLE IF NOT EXISTS article_topic (
  article_id uuid NOT NULL REFERENCES article (id) ON DELETE CASCADE,
  topic_id   uuid NOT NULL REFERENCES topic (id) ON DELETE CASCADE,
  confidence numeric NOT NULL,
  PRIMARY KEY (article_id, topic_id),
  CONSTRAINT article_topic_confidence_range_chk CHECK (confidence BETWEEN 0.0 AND 1.0)
);

CREATE INDEX IF NOT EXISTS article_topic_topic_id_idx ON article_topic (topic_id);

-- user_embedding: the user's 1536-dim interest vector. Absence of a row =>
-- "no User_Embedding", triggering the Ranking_Engine fallback (Requirement 9.7).
CREATE TABLE IF NOT EXISTS user_embedding (
  user_id    uuid PRIMARY KEY REFERENCES "user" (id) ON DELETE CASCADE,
  embedding  vector(1536) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
