export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  is_fork INTEGER NOT NULL DEFAULT 0,
  UNIQUE(owner, name)
);

CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  is_pull_request INTEGER NOT NULL,
  state TEXT NOT NULL,
  author TEXT,
  assignees TEXT NOT NULL DEFAULT '[]',
  milestone TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  comments INTEGER NOT NULL DEFAULT 0,
  issue_type_id TEXT,
  issue_type_name TEXT
);
CREATE INDEX IF NOT EXISTS idx_issues_repo ON issues(repo_id);
CREATE INDEX IF NOT EXISTS idx_issues_updated ON issues(updated_at);

CREATE TABLE IF NOT EXISTS issue_labels (
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  color TEXT,
  PRIMARY KEY (issue_id, label)
);
CREATE INDEX IF NOT EXISTS idx_issue_labels_label ON issue_labels(label);

CREATE TABLE IF NOT EXISTS issue_types (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT,
  description TEXT
);

CREATE TABLE IF NOT EXISTS field_definitions (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  data_type TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_field_defs_repo ON field_definitions(repo_id);

CREATE TABLE IF NOT EXISTS field_options (
  id TEXT PRIMARY KEY,
  field_definition_id TEXT NOT NULL REFERENCES field_definitions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT,
  position INTEGER
);

CREATE TABLE IF NOT EXISTS issue_field_values (
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL,
  data_type TEXT NOT NULL,
  value_text TEXT,
  value_number REAL,
  value_date TEXT,
  option_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_ifv_issue ON issue_field_values(issue_id);
CREATE INDEX IF NOT EXISTS idx_ifv_name_text ON issue_field_values(field_name, value_text);

CREATE TABLE IF NOT EXISTS sync_state (
  repo_id TEXT PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  last_synced_at TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  error TEXT
);

CREATE TABLE IF NOT EXISTS tab_repos (
  position INTEGER NOT NULL,
  tab_name TEXT NOT NULL,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  PRIMARY KEY (position, repo_id)
);
CREATE INDEX IF NOT EXISTS idx_tab_repos_pos ON tab_repos(position);
`;
