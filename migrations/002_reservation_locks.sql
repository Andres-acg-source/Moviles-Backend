CREATE UNIQUE INDEX one_active_per_user ON reservations (user_id) WHERE status = 'active' AND user_id IS NOT NULL;
CREATE UNIQUE INDEX one_open_per_spot ON reservations (spot_id) WHERE status IN ('active', 'fulfilled') AND released_at IS NULL;
