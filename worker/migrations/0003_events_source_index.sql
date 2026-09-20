-- componentMetrics/sourceBreakdown/bucketedLayer all filter on `source`
-- (every frontend call defaults to source=live), but no index led with
-- `source` existed -- every poll fell back to a full table scan of `events`,
-- which still holds ~21k rows from an earlier seeding run. At a 5s dashboard
-- poll interval that alone burned through a full day's D1 read quota.
CREATE INDEX IF NOT EXISTS idx_events_source_component ON events(source, component_id);
CREATE INDEX IF NOT EXISTS idx_events_source_type ON events(source, type);
