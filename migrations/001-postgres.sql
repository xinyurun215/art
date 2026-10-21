BEGIN;
CREATE TABLE IF NOT EXISTS art_budget_runs (
  id text PRIMARY KEY,
  limits jsonb NOT NULL,
  shared_limits jsonb NOT NULL,
  usage jsonb NOT NULL DEFAULT '{"modelHttpAttempts":0,"qlooHttpAttempts":0}',
  live_stopped boolean NOT NULL DEFAULT false,
  query_stopped boolean NOT NULL DEFAULT false,
  lease_token text,
  lease_project text,
  lease_until timestamptz
);
CREATE TABLE IF NOT EXISTS art_projects (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES art_budget_runs(id),
  revision integer NOT NULL CHECK (revision > 0),
  state jsonb NOT NULL,
  lease_token text,
  lease_until timestamptz
);
CREATE TABLE IF NOT EXISTS art_http_attempts (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES art_budget_runs(id),
  project_id text NOT NULL REFERENCES art_projects(id),
  run_token text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('model', 'qloo')),
  detail jsonb NOT NULL
);
COMMIT;
