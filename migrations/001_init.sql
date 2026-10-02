CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  name text,
  password_hash text NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE levels (
  code text PRIMARY KEY,
  name text NOT NULL,
  sort int NOT NULL,
  underground boolean NOT NULL
);

CREATE TABLE spots (
  id text PRIMARY KEY,
  level_code text NOT NULL REFERENCES levels,
  zone text NOT NULL,
  code text NOT NULL,
  is_accessible boolean NOT NULL,
  is_ev boolean NOT NULL,
  is_vip boolean NOT NULL,
  x_m real NOT NULL,
  y_m real NOT NULL,
  status text NOT NULL CHECK (status IN ('free', 'reserved', 'occupied', 'disabled')),
  held_by uuid NULL REFERENCES users ON DELETE SET NULL,
  source text NULL CHECK (source IN ('sim', 'user')),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX spots_level_status_idx ON spots (level_code, status);

CREATE TABLE buildings (
  id text PRIMARY KEY,
  name text NOT NULL,
  x_m real NOT NULL,
  y_m real NOT NULL
);

CREATE TABLE reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NULL REFERENCES users ON DELETE CASCADE,
  spot_id text NOT NULL REFERENCES spots,
  source text NOT NULL CHECK (source IN ('user', 'sim')),
  status text NOT NULL CHECK (status IN ('active', 'fulfilled', 'released', 'cancelled', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  checked_in_at timestamptz,
  released_at timestamptz
);
CREATE INDEX reservations_user_created_idx ON reservations (user_id, created_at DESC);
CREATE INDEX reservations_created_idx ON reservations (created_at);

CREATE TABLE telemetry_events (
  id bigserial PRIMARY KEY,
  user_id uuid NULL,
  name text NOT NULL,
  properties jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX telemetry_events_name_created_idx ON telemetry_events (name, created_at);

CREATE TABLE unmet_demand (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL,
  slot_start timestamptz NOT NULL,
  weekday int NOT NULL,
  zone text NOT NULL,
  UNIQUE (user_id, slot_start)
);

CREATE TABLE occupancy_snapshots (
  level_code text NOT NULL REFERENCES levels,
  taken_at timestamptz NOT NULL,
  total int NOT NULL,
  free int NOT NULL,
  reserved int NOT NULL,
  occupied int NOT NULL,
  source text NOT NULL,
  PRIMARY KEY (level_code, taken_at)
);

CREATE TABLE nearby_lots (
  id text PRIMARY KEY,
  name text NOT NULL,
  address text NOT NULL,
  rate_per_hour int NOT NULL,
  currency text NOT NULL,
  walk_minutes int NOT NULL
);
