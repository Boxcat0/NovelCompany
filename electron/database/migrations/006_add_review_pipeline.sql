CREATE TABLE review_runs (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE RESTRICT,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
  processor_key TEXT NOT NULL,
  episode_content_hash TEXT NOT NULL,
  canon_context_hash TEXT NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE review_findings (
  id TEXT PRIMARY KEY,
  review_run_id TEXT NOT NULL REFERENCES review_runs(id) ON DELETE RESTRICT,
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (review_run_id, sort_order)
);

CREATE INDEX idx_review_runs_episode_created_at
  ON review_runs (episode_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX idx_review_runs_episode_running
  ON review_runs (episode_id)
  WHERE status = 'RUNNING';
CREATE INDEX idx_review_findings_run_sort_order
  ON review_findings (review_run_id, sort_order ASC, id ASC);
