import type Database from "better-sqlite3";
import type { Config, GroupFilter, Tab } from "../config/schema.js";
import type { FieldDataType } from "../db/fields.js";
import { listTabMemberships, type TabMembership } from "../db/membership.js";
import { compileFilter } from "./filter.js";

export interface FieldView {
  name: string;
  dataType: FieldDataType;
  value: string | number | null;
  optionColor?: string;
}

export interface IssueView {
  id: string;
  repo: string;
  number: number;
  title: string;
  isPullRequest: boolean;
  state: string;
  author: string | null;
  assignees: string[];
  labels: string[];
  milestone: string | null;
  createdAt: string;
  updatedAt: string;
  comments: number;
  issueTypeName: string | null;
  url: string;
  fields: FieldView[];
}

export interface GroupView {
  name: string;
  issues: IssueView[];
}

export interface TabView {
  name: string;
  groups: GroupView[];
}

interface JoinedIssueRow {
  id: string;
  repo_owner: string;
  repo_name: string;
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
  issue_type_name: string | null;
}

function hydrate(db: Database.Database, r: JoinedIssueRow): IssueView {
  const labels = (
    db
      .prepare("SELECT label FROM issue_labels WHERE issue_id = ? ORDER BY label")
      .all(r.id) as Array<{ label: string }>
  ).map((x) => x.label);

  const fieldRows = db
    .prepare(
      `SELECT v.field_name, v.data_type, v.value_text, v.value_number, v.value_date, o.color AS option_color
       FROM issue_field_values v
       LEFT JOIN field_options o ON o.id = v.option_id
       WHERE v.issue_id = ?`,
    )
    .all(r.id) as Array<{
    field_name: string;
    data_type: FieldDataType;
    value_text: string | null;
    value_number: number | null;
    value_date: string | null;
    option_color: string | null;
  }>;

  const fields: FieldView[] = fieldRows.map((f) => ({
    name: f.field_name,
    dataType: f.data_type,
    value: f.value_text ?? f.value_number ?? f.value_date,
    optionColor: f.option_color ?? undefined,
  }));

  const isPullRequest = r.is_pull_request === 1;
  return {
    id: r.id,
    repo: `${r.repo_owner}/${r.repo_name}`,
    number: r.number,
    title: r.title,
    isPullRequest,
    state: r.state,
    author: r.author,
    assignees: JSON.parse(r.assignees) as string[],
    labels,
    milestone: r.milestone,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    comments: r.comments,
    issueTypeName: r.issue_type_name,
    url: `https://github.com/${r.repo_owner}/${r.repo_name}/${isPullRequest ? "pull" : "issues"}/${r.number}`,
    fields,
  };
}

function buildGroup(
  db: Database.Database,
  name: string,
  filter: GroupFilter | undefined,
  repoIds: string[],
  now: Date,
): GroupView {
  const { where, params } = compileFilter(filter, repoIds, now);
  const rows = db
    .prepare(
      `SELECT issues.id, issues.number, issues.title, issues.is_pull_request, issues.state,
              issues.author, issues.assignees, issues.milestone, issues.created_at,
              issues.updated_at, issues.comments, issues.issue_type_name,
              repos.owner AS repo_owner, repos.name AS repo_name
       FROM issues JOIN repos ON repos.id = issues.repo_id
       WHERE ${where}
       ORDER BY issues.updated_at DESC`,
    )
    .all(...params) as JoinedIssueRow[];
  return { name, issues: rows.map((r) => hydrate(db, r)) };
}

export function assembleTab(
  db: Database.Database,
  membership: TabMembership,
  tab: Tab,
  now: Date,
): TabView {
  const groups =
    tab.groups && tab.groups.length > 0
      ? tab.groups.map((g) => buildGroup(db, g.name, g.filter, membership.repoIds, now))
      : [buildGroup(db, "All open issues and PRs", undefined, membership.repoIds, now)];
  return { name: tab.name, groups };
}

export function assembleAllTabs(db: Database.Database, config: Config, now: Date): TabView[] {
  const out: TabView[] = [];
  for (const m of listTabMemberships(db)) {
    const tab = config.tabs[m.position];
    if (tab) out.push(assembleTab(db, m, tab, now));
  }
  return out;
}
