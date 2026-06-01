-- 0002_users_and_auth.sql
-- Identity, OAuth linkage, and refresh tokens.
--
-- Requirements: 1.x (accounts), 2.x (tokens), 26.x (profile).
-- Design: "PostgreSQL Schema (logical)" -> user, oauth_identity, refresh_token.

-- user: a Lumina account. Quoted because "user" is a reserved word.
CREATE TABLE IF NOT EXISTS "user" (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- citext UNIQUE, valid format, <= 254 chars (Requirements 1.3, 26.2).
  email                   citext NOT NULL UNIQUE,
  -- null for OAuth-only accounts (Requirement 1.5).
  password_hash           text,
  display_name            varchar(50) NOT NULL,
  avatar_url              text,
  depth_preference        depth_preference NOT NULL DEFAULT 'balanced',
  -- Daily_Goal in minutes, 5-120, default 15 (Requirements 1.4, 3.5).
  daily_goal_minutes      integer NOT NULL DEFAULT 15,
  -- Push disabled by default at account creation (Requirement 18.1).
  push_enabled            boolean NOT NULL DEFAULT false,
  -- null => route the user to onboarding (Requirement 4.1).
  onboarding_completed_at timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_email_length_chk CHECK (char_length(email::text) <= 254),
  CONSTRAINT user_daily_goal_range_chk CHECK (daily_goal_minutes BETWEEN 5 AND 120)
);

-- oauth_identity: a federated identity linked to a user (Requirement 1.5).
CREATE TABLE IF NOT EXISTS oauth_identity (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  provider         oauth_provider NOT NULL,
  provider_user_id text NOT NULL,
  email            citext,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT oauth_identity_provider_uid_key UNIQUE (provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS oauth_identity_user_id_idx ON oauth_identity (user_id);

-- refresh_token: a hashed, expiring refresh token (Requirements 2.1, 2.5).
CREATE TABLE IF NOT EXISTS refresh_token (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  -- Stored hashed at rest; never the raw token.
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS refresh_token_user_id_idx ON refresh_token (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS refresh_token_token_hash_key ON refresh_token (token_hash);
