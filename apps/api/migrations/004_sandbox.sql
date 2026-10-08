-- Temporary "try it yourself" workspaces. A tenant with expires_at set is a sandbox: its tokens stop
-- working at that time and the daily cron deletes it (every tenant-owned table cascades). NULL, the
-- default, keeps every existing tenant permanent.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS expires_at timestamptz;
-- The cleanup and the active-sandbox cap only ever look at sandboxes.
CREATE INDEX IF NOT EXISTS tenants_expires_idx ON tenants (expires_at) WHERE expires_at IS NOT NULL;
