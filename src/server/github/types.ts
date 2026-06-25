export type FieldDataType =
  | "single_select"
  | "multi_select"
  | "number"
  | "text"
  | "date";

export interface RepoInfo {
  id: string;
  owner: string;
  name: string;
  isFork: boolean;
  isArchived: boolean;
}

export interface FetchedFieldValue {
  fieldName: string;
  dataType: FieldDataType;
  valueText?: string;
  valueNumber?: number;
  valueDate?: string;
  optionId?: string;
}

export interface FetchedIssue {
  id: string;
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
  issueType: { id: string; name: string } | null;
  fieldValues: FetchedFieldValue[];
}

const TYPE_MAP: Record<string, FieldDataType> = {
  SINGLE_SELECT: "single_select",
  MULTI_SELECT: "multi_select",
  NUMBER: "number",
  TEXT: "text",
  DATE: "date",
};

export function normalizeDataType(apiType: string): FieldDataType {
  const t = TYPE_MAP[apiType];
  if (!t) throw new Error(`Unknown field data type: ${apiType}`);
  return t;
}
