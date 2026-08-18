-- ============================================================
-- English Passport Pro — PostgreSQL schema
-- Run this once against your database to create all tables.
-- Safe to re-run: every statement is IF NOT EXISTS / idempotent-ish,
-- but on a fresh database just run it top to bottom.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- for gen_random_uuid()

-- ------------------------------------------------------------
-- USERS — permanent account, permanent 4-digit user_code
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  user_code      VARCHAR(4) UNIQUE NOT NULL CHECK (user_code ~ '^[0-9]{4}$'),
  email          VARCHAR(255) UNIQUE NOT NULL,
  display_name   VARCHAR(100) NOT NULL,
  password_hash  TEXT NOT NULL,
  avatar_url     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_user_code ON users(user_code);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ------------------------------------------------------------
-- SESSIONS — server-side session tokens (httpOnly cookie holds
-- the raw token; only its hash is stored here, so a DB leak alone
-- can't be used to impersonate a logged-in user)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  user_agent  TEXT,
  ip_address  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);

-- ------------------------------------------------------------
-- PASSWORD RESETS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS password_resets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_password_resets_token_hash ON password_resets(token_hash);

-- ------------------------------------------------------------
-- FRIEND REQUESTS + FRIENDSHIPS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS friend_requests (
  id            SERIAL PRIMARY KEY,
  from_user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        VARCHAR(20) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','accepted','rejected','cancelled')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at  TIMESTAMPTZ,
  UNIQUE (from_user_id, to_user_id)
);
CREATE INDEX IF NOT EXISTS idx_friend_requests_to_user ON friend_requests(to_user_id, status);

CREATE TABLE IF NOT EXISTS friendships (
  id           SERIAL PRIMARY KEY,
  user_a_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (user_a_id < user_b_id),
  UNIQUE (user_a_id, user_b_id)
);
CREATE INDEX IF NOT EXISTS idx_friendships_a ON friendships(user_a_id);
CREATE INDEX IF NOT EXISTS idx_friendships_b ON friendships(user_b_id);

-- ------------------------------------------------------------
-- BLOCKS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS blocks (
  id          SERIAL PRIMARY KEY,
  blocker_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (blocker_id, blocked_id)
);
CREATE INDEX IF NOT EXISTS idx_blocks_blocker ON blocks(blocker_id);
CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blocked_id);

-- ------------------------------------------------------------
-- MEDIA — file reference only; actual bytes live in object storage
-- (S3/Cloudinary/etc.), never in the database itself.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS media (
  id               SERIAL PRIMARY KEY,
  uploader_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_url         TEXT NOT NULL,
  file_type        VARCHAR(50) NOT NULL,
  file_size_bytes  BIGINT,
  original_name    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- CONVERSATIONS + MESSAGES
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
  id               SERIAL PRIMARY KEY,
  user_a_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_at  TIMESTAMPTZ,
  CHECK (user_a_id < user_b_id),
  UNIQUE (user_a_id, user_b_id)
);
CREATE INDEX IF NOT EXISTS idx_conversations_a ON conversations(user_a_id);
CREATE INDEX IF NOT EXISTS idx_conversations_b ON conversations(user_b_id);

CREATE TABLE IF NOT EXISTS messages (
  id               BIGSERIAL PRIMARY KEY,
  conversation_id  INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body             TEXT,
  media_id         INTEGER REFERENCES media(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at        TIMESTAMPTZ,
  deleted_at       TIMESTAMPTZ,
  CHECK (body IS NOT NULL OR media_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS message_status (
  id            BIGSERIAL PRIMARY KEY,
  message_id    BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delivered_at  TIMESTAMPTZ,
  read_at       TIMESTAMPTZ,
  UNIQUE (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_message_status_message ON message_status(message_id);

-- ------------------------------------------------------------
-- NOTIFICATIONS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        VARCHAR(30) NOT NULL, -- 'message' | 'friend_request' | 'missed_call' | ...
  payload     JSONB NOT NULL DEFAULT '{}',
  is_read     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);

-- ------------------------------------------------------------
-- CALLS + PARTICIPANTS (1:1 and group)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calls (
  id                SERIAL PRIMARY KEY,
  call_type         VARCHAR(10) NOT NULL CHECK (call_type IN ('1:1','group')),
  media_type        VARCHAR(10) NOT NULL CHECK (media_type IN ('voice','video')),
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at          TIMESTAMPTZ,
  duration_seconds  INTEGER
);

CREATE TABLE IF NOT EXISTS call_participants (
  id        SERIAL PRIMARY KEY,
  call_id   INTEGER NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_call_participants_call ON call_participants(call_id);
CREATE INDEX IF NOT EXISTS idx_call_participants_user ON call_participants(user_id);
