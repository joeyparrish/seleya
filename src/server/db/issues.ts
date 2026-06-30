import type Database from "better-sqlite3";

export interface LabelRef {
  name: string;
  color: string | null;
}

export interface IssueRecord {
  id: string;
  repoId: string;
  number: number;
  title: string;
  isPullRequest: boolean;
  state: string;
  author: string | null;
  assignees: string[];
  labels: LabelRef[];
  milestone: string | null;
  createdAt: string;
  updatedAt: string;
  comments: number;
  issueTypeId: string | null;
  issueTypeName: string | null;
}

interface RawIssue {
  id: string;
  repo_id: string;
  number: number;
  title: string;
  is_pull_request: number;
  state: string;
  author: string | null;
  assignees: string;
  milestone: string | null;
  created_at: string;
  updated_at: string;
  comments: number;
  issue_type_id: string | null;
  issue_type_name: string | null;
}

export function upsertIssue(db: Database.Database, issue: IssueRecord): void {
  const tx = db.transaction((i: IssueRecord) => {
    db.prepare(
      `INSERT INTO issues
         (id, repo_id, number, title, is_pull_request, state, author, assignees,
          milestone, created_at, updated_at, comments, issue_type_id, issue_type_name)
       VALUES
         (@id, @repo_id, @number, @title, @is_pull_request, @state, @author, @assignees,
          @milestone, @created_at, @updated_at, @comments, @issue_type_id, @issue_type_name)
       ON CONFLICT(id) DO UPDATE SET
         repo_id=@repo_id, number=@number, title=@title, is_pull_request=@is_pull_request,
         state=@state, author=@author, assignees=@assignees, milestone=@milestone,
         created_at=@created_at, updated_at=@updated_at, comments=@comments,
         issue_type_id=@issue_type_id, issue_type_name=@issue_type_name`,
    ).run({
      id: i.id,
      repo_id: i.repoId,
      number: i.number,
      title: i.title,
      is_pull_request: i.isPullRequest ? 1 : 0,
      state: i.state,
      author: i.author,
      assignees: JSON.stringify(i.assignees),
      milestone: i.milestone,
      created_at: i.createdAt,
      updated_at: i.updatedAt,
      comments: i.comments,
      issue_type_id: i.issueTypeId,
      issue_type_name: i.issueTypeName,
    });

    db.prepare("DELETE FROM issue_labels WHERE issue_id=?").run(i.id);
    const insLabel = db.prepare(
      "INSERT INTO issue_labels (issue_id, label, color) VALUES (?, ?, ?)",
    );
    for (const label of i.labels) insLabel.run(i.id, label.name, label.color);
  });
  tx(issue);
}

export function deleteIssue(db: Database.Database, id: string): void {
  db.prepare("DELETE FROM issues WHERE id=?").run(id);
}

export function listIssueIdsByRepo(db: Database.Database, repoId: string): string[] {
  const rows = db
    .prepare("SELECT id FROM issues WHERE repo_id=?")
    .all(repoId) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

export function getIssue(db: Database.Database, id: string): IssueRecord | undefined {
  const row = db.prepare("SELECT * FROM issues WHERE id=?").get(id) as RawIssue | undefined;
  if (!row) return undefined;
  const labels = (
    db
      .prepare("SELECT label, color FROM issue_labels WHERE issue_id=? ORDER BY label")
      .all(id) as Array<{ label: string; color: string | null }>
  ).map((r) => ({ name: r.label, color: r.color }));
  return {
    id: row.id,
    repoId: row.repo_id,
    number: row.number,
    title: row.title,
    isPullRequest: row.is_pull_request === 1,
    state: row.state,
    author: row.author,
    assignees: JSON.parse(row.assignees) as string[],
    labels,
    milestone: row.milestone,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    comments: row.comments,
    issueTypeId: row.issue_type_id,
    issueTypeName: row.issue_type_name,
  };
}
