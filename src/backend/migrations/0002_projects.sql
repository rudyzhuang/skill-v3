-- Shared with PROJECT-CREATE-001, BACKEND-API-QUERY-001, PROJECT-LIST-001
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY NOT NULL,
  name_zh TEXT NOT NULL,
  name_en TEXT NOT NULL,
  description TEXT,
  client_targets TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  is_new INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  root_path TEXT,
  pipeline_summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_status ON projects (status);
CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects (updated_at DESC);
