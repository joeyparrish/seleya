// Mirrors the server's view types (src/server/query/assemble.ts and
// src/server/refresh/orchestrator.ts). Kept in sync by hand: the client is a
// separate Vite project and does not import server modules.

export type FieldDataType = "single_select" | "multi_select" | "number" | "text" | "date";

export interface FieldView {
  name: string;
  dataType: FieldDataType;
  value: string | number | null;
  optionColor?: string;
}

export interface LabelView {
  name: string;
  color: string | null;
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
  labels: LabelView[];
  milestone: string | null;
  createdAt: string;
  updatedAt: string;
  comments: number;
  issueTypeName: string | null;
  issueTypeColor: string | null;
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

export interface TabSummary {
  index: number;
  name: string;
}

export interface RefreshStatus {
  running: boolean;
  deep: boolean;
  phase: "sync" | "reconcile" | null;
  startedAt: string | null;
  finishedAt: string | null;
  total: number;
  completed: number;
  errors: number;
  currentRepos: string[];
  lastError: string | null;
}
