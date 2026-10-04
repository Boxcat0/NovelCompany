CREATE TABLE review_jobs (
  queue_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE RESTRICT,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'RESUBMIT_REQUIRED')),
  episode_content_hash TEXT NOT NULL,
  canon_context_hash TEXT NOT NULL,
  context_mode TEXT NOT NULL CHECK (context_mode = 'RELEVANT_CANON_V1'),
  fingerprint_version TEXT NOT NULL CHECK (fingerprint_version = 'V2'),
  review_run_id TEXT UNIQUE REFERENCES review_runs(id) ON DELETE RESTRICT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE UNIQUE INDEX idx_review_jobs_episode_active ON review_jobs(episode_id)
  WHERE status IN ('QUEUED', 'RUNNING');
CREATE UNIQUE INDEX idx_review_jobs_global_running ON review_jobs((1))
  WHERE status = 'RUNNING';
CREATE INDEX idx_review_jobs_status_sequence ON review_jobs(status, queue_sequence);
CREATE INDEX idx_review_jobs_episode_sequence ON review_jobs(episode_id, queue_sequence DESC);
