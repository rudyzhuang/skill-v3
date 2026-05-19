CREATE TABLE IF NOT EXISTS pipeline_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  stages_hash TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects (id)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_snapshots_project_updated
  ON pipeline_snapshots (project_id, updated_at DESC);
