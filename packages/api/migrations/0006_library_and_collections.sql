-- 0006_library_and_collections.sql
-- Saved articles, read state, and user collections.
--
-- Requirements: 21.x (saves, read state), 22.x (collections).
-- Design: "PostgreSQL Schema (logical)" -> saved_article, collection, collection_article.

-- saved_article: a user's saved article with read state. PK enforces
-- idempotent saving: at most one row per (user, article) (Requirement 21.5).
CREATE TABLE IF NOT EXISTS saved_article (
  user_id    uuid NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  article_id uuid NOT NULL REFERENCES article (id) ON DELETE CASCADE,
  read_state read_state NOT NULL DEFAULT 'unread',
  saved_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, article_id)
);

CREATE INDEX IF NOT EXISTS saved_article_user_id_saved_at_idx
  ON saved_article (user_id, saved_at);

-- collection: a named, user-owned grouping of saved articles (Requirement 22.1).
CREATE TABLE IF NOT EXISTS collection (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  name       varchar(100) NOT NULL,
  color      text NOT NULL,
  icon       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT collection_name_length_chk CHECK (char_length(name) BETWEEN 1 AND 100)
);

CREATE INDEX IF NOT EXISTS collection_user_id_idx ON collection (user_id);

-- collection_article: membership of an article in a collection. Deleting a
-- collection cascades here but preserves the underlying saved_article
-- (Requirement 22.4).
CREATE TABLE IF NOT EXISTS collection_article (
  collection_id uuid NOT NULL REFERENCES collection (id) ON DELETE CASCADE,
  article_id    uuid NOT NULL REFERENCES article (id) ON DELETE CASCADE,
  added_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, article_id)
);

CREATE INDEX IF NOT EXISTS collection_article_article_id_idx
  ON collection_article (article_id);
