-- 0005_feed_events.sql
-- Append-only behaviour signals ingested from the Mobile_App.
--
-- Requirements: 13.1 (persist with all references), 13.4 (idempotency).
-- Design: "PostgreSQL Schema (logical)" -> feed_event.

-- feed_event: one recorded behaviour signal.
-- (user_id, client_event_id) is UNIQUE so re-sent batches are idempotent
-- (Requirement 13.4). article_id is null for session_end; topic_id is set for
-- mute_topic events.
CREATE TABLE IF NOT EXISTS feed_event (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_event_id uuid NOT NULL,
  user_id         uuid NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  article_id      uuid REFERENCES article (id) ON DELETE SET NULL,
  topic_id        uuid REFERENCES topic (id) ON DELETE SET NULL,
  type            feed_event_type NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- client-supplied occurrence time.
  occurred_at     timestamptz NOT NULL,
  -- server receipt time.
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT feed_event_user_client_event_key UNIQUE (user_id, client_event_id)
);

CREATE INDEX IF NOT EXISTS feed_event_user_id_occurred_at_idx
  ON feed_event (user_id, occurred_at);
CREATE INDEX IF NOT EXISTS feed_event_user_id_type_idx
  ON feed_event (user_id, type);
CREATE INDEX IF NOT EXISTS feed_event_article_id_idx
  ON feed_event (article_id);
