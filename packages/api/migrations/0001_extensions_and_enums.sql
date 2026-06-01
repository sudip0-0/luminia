-- 0001_extensions_and_enums.sql
-- Enable required PostgreSQL extensions and define the shared enum types.
--
-- Requirements: 6.5, 7.5, 9.x (embeddings), 13.1
-- Design: "PostgreSQL Schema (logical)".

-- Vector similarity (relevance, related articles, centroids) via pgvector.
CREATE EXTENSION IF NOT EXISTS vector;

-- Case-insensitive text for unique, format-checked emails.
CREATE EXTENSION IF NOT EXISTS citext;

-- gen_random_uuid() is available in core PostgreSQL 13+, which the design
-- targets (PostgreSQL 15+). No extension is required for UUID generation.

-- depth_preference: user reading-depth preference (Requirement 3.4).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'depth_preference') THEN
    CREATE TYPE depth_preference AS ENUM ('quick', 'balanced', 'deep');
  END IF;
END$$;

-- oauth_provider: supported OAuth providers (Requirement 1.5).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'oauth_provider') THEN
    CREATE TYPE oauth_provider AS ENUM ('google', 'apple');
  END IF;
END$$;

-- user_topic_source: provenance of a user's topic association.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_topic_source') THEN
    CREATE TYPE user_topic_source AS ENUM ('onboarding', 'inferred');
  END IF;
END$$;

-- content_source: the six supported content providers (Requirement 5.1).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'content_source') THEN
    CREATE TYPE content_source AS ENUM (
      'wikipedia', 'medium', 'hacker_news', 'arxiv', 'mit_news', 'quanta'
    );
  END IF;
END$$;

-- difficulty: article difficulty levels (Requirement 7.1).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'difficulty') THEN
    CREATE TYPE difficulty AS ENUM ('introductory', 'intermediate', 'advanced');
  END IF;
END$$;

-- summarization_status: lifecycle of an article's summary.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'summarization_status') THEN
    CREATE TYPE summarization_status AS ENUM ('pending', 'summarized', 'unsummarized');
  END IF;
END$$;

-- feed_event_type: the complete set of behaviour signal types
-- (Requirement 12; validated by Feed_Event_Service per Requirement 13.2).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'feed_event_type') THEN
    CREATE TYPE feed_event_type AS ENUM (
      'impression', 'dwell', 'expand', 'scroll_depth', 'save', 'unsave',
      'share', 'link_out', 'skip', 'mute_topic', 'session_end'
    );
  END IF;
END$$;

-- read_state: saved-article read state (Requirement 21.3).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'read_state') THEN
    CREATE TYPE read_state AS ENUM ('read', 'unread');
  END IF;
END$$;
