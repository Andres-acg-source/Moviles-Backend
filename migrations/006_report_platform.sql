ALTER TABLE spot_reports
  ADD COLUMN platform text NOT NULL DEFAULT 'android'
  CHECK (platform IN ('android', 'ios'));
