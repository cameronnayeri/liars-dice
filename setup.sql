-- ============================================================
--  LIAR'S DICE — Supabase Setup
--  Run this entire file in the Supabase SQL Editor
--  (Dashboard → SQL Editor → New Query → Paste → Run)
-- ============================================================

-- Drop tables if re-running (comment out if you want to preserve data)
-- DROP TABLE IF EXISTS players CASCADE;
-- DROP TABLE IF EXISTS lobbies CASCADE;

CREATE TABLE IF NOT EXISTS lobbies (
  code        TEXT        PRIMARY KEY CHECK (char_length(code) = 4),
  host_player_id TEXT     NOT NULL,
  settings    JSONB       NOT NULL DEFAULT '{
    "mode": "perudo",
    "startingDice": 5,
    "onesWild": true,
    "spotOnEnabled": true,
    "palaficoEnabled": true,
    "maxPlayers": 8
  }'::jsonb,
  game_state  JSONB       NOT NULL DEFAULT '{}'::jsonb,
  status      TEXT        NOT NULL DEFAULT 'waiting'
                CHECK (status IN ('waiting', 'playing', 'finished')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS players (
  id              TEXT        PRIMARY KEY,
  lobby_code      TEXT        NOT NULL REFERENCES lobbies(code) ON DELETE CASCADE,
  name            TEXT        NOT NULL CHECK (char_length(trim(name)) >= 1 AND char_length(name) <= 20),
  dice_color      TEXT        NOT NULL DEFAULT '#c41e3a',
  seat_order      INTEGER,
  is_host         BOOLEAN     NOT NULL DEFAULT FALSE,
  dice_count      INTEGER     NOT NULL DEFAULT 5,
  is_eliminated   BOOLEAN     NOT NULL DEFAULT FALSE,
  revealed_dice   JSONB                DEFAULT NULL,
  last_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Disable RLS — this app is for trusted friends only, not public prod use
ALTER TABLE lobbies DISABLE ROW LEVEL SECURITY;
ALTER TABLE players DISABLE ROW LEVEL SECURITY;

-- Enable Realtime on both tables
ALTER PUBLICATION supabase_realtime ADD TABLE lobbies;
ALTER PUBLICATION supabase_realtime ADD TABLE players;

-- Auto-update updated_at on lobbies
CREATE OR REPLACE FUNCTION handle_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_lobbies_updated ON lobbies;
CREATE TRIGGER on_lobbies_updated
  BEFORE UPDATE ON lobbies
  FOR EACH ROW EXECUTE FUNCTION handle_updated_at();

-- Optional: clean up old finished lobbies (run manually as needed)
-- DELETE FROM lobbies WHERE status = 'finished' AND updated_at < NOW() - INTERVAL '24 hours';
