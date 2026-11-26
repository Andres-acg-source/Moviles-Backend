CREATE TABLE spot_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  client_id uuid NOT NULL,
  spot_id text NOT NULL REFERENCES spots,
  level_code text NOT NULL REFERENCES levels,
  kind text NOT NULL CHECK (kind IN ('occupied', 'blocked', 'damaged', 'other')),
  note text NULL CHECK (char_length(note) <= 280),
  shown_status text NOT NULL CHECK (shown_status IN ('free', 'reserved', 'occupied', 'disabled')),
  photo bytea NULL,
  reported_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, client_id)
);
CREATE INDEX spot_reports_user_reported_idx ON spot_reports (user_id, reported_at DESC);
CREATE INDEX spot_reports_reported_idx ON spot_reports (reported_at);
