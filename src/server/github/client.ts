import { graphql } from "@octokit/graphql";
import {
  normalizeDataType,
  type FetchedFieldValue,
  type FetchedIssue,
  type FieldDataType,
  type RepoInfo,
} from "./types.js";

export type GraphQLRequest = <T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
) => Promise<T>;

export interface IssueTypeDiscovery {
  id: string;
  name: string;
  color: string | null;
  description: string | null;
}

export interface FieldDiscovery {
  id: string;
  name: string;
  dataType: FieldDataType;
  options: Array<{ id: string; name: string; color: string | null; position: number | null }>;
}

export interface GitHubClient {
  listOrgRepos(org: string): Promise<RepoInfo[]>;
  listUserRepos(username: string): Promise<RepoInfo[]>;
  getRepo(owner: string, name: string): Promise<RepoInfo | null>;
  fetchIssuesUpdatedSince(
    owner: string,
    name: string,
    since: string | null,
  ): Promise<FetchedIssue[]>;
  discoverIssueTypes(owner: string, name: string): Promise<IssueTypeDiscovery[]>;
  discoverFields(owner: string, name: string): Promise<FieldDiscovery[]>;
}

export function createDefaultRequest(token: string): GraphQLRequest {
  const authed = graphql.defaults({ headers: { authorization: `token ${token}` } });
  return ((query, variables) => authed(query, variables)) as GraphQLRequest;
}

const REPO_FIELDS = `nodes { id name isFork isArchived owner { login } } pageInfo { hasNextPage endCursor }`;

const ISSUE_NODE = `
  id number title state createdAt updatedAt
  author { login }
  assignees(first: 20) { nodes { login } }
  labels(first: 50) { nodes { name } }
  milestone { title }
  comments { totalCount }
  issueType { id name }
  issueFieldValues(first: 50) {
    nodes {
      __typename
      ... on IssueFieldSingleSelectValue { ssValue: value optionId field { ... on IssueFieldSingleSelect { name } } }
      ... on IssueFieldMultiSelectValue  { msValues: value field { ... on IssueFieldMultiSelect { name } } }
      ... on IssueFieldNumberValue       { numValue: value field { ... on IssueFieldNumber { name } } }
      ... on IssueFieldTextValue         { txtValue: value field { ... on IssueFieldText { name } } }
      ... on IssueFieldDateValue         { dateValue: value field { ... on IssueFieldDate { name } } }
    }
  }`;

const PR_NODE = `id number title state createdAt updatedAt
  author { login }
  assignees(first: 20) { nodes { login } }
  labels(first: 50) { nodes { name } }
  milestone { title }
  comments { totalCount }`;

interface Page<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

function mapRepo(n: {
  id: string;
  name: string;
  isFork: boolean;
  isArchived: boolean;
  owner: { login: string };
}): RepoInfo {
  return { id: n.id, owner: n.owner.login, name: n.name, isFork: n.isFork, isArchived: n.isArchived };
}

function mapFieldValues(nodes: any[]): FetchedFieldValue[] {
  const out: FetchedFieldValue[] = [];
  for (const n of nodes ?? []) {
    const fieldName = n.field?.name as string | undefined;
    if (!fieldName) continue;
    switch (n.__typename) {
      case "IssueFieldSingleSelectValue":
        out.push({ fieldName, dataType: "single_select", valueText: n.ssValue, optionId: n.optionId });
        break;
      case "IssueFieldMultiSelectValue":
        for (const v of n.msValues ?? []) {
          out.push({ fieldName, dataType: "multi_select", valueText: v });
        }
        break;
      case "IssueFieldNumberValue":
        out.push({ fieldName, dataType: "number", valueNumber: n.numValue });
        break;
      case "IssueFieldTextValue":
        out.push({ fieldName, dataType: "text", valueText: n.txtValue });
        break;
      case "IssueFieldDateValue":
        out.push({ fieldName, dataType: "date", valueDate: n.dateValue });
        break;
    }
  }
  return out;
}

function mapIssue(n: any, isPullRequest: boolean): FetchedIssue {
  return {
    id: n.id,
    number: n.number,
    title: n.title,
    isPullRequest,
    state: n.state,
    author: n.author?.login ?? null,
    assignees: (n.assignees?.nodes ?? []).map((a: any) => a.login),
    labels: (n.labels?.nodes ?? []).map((l: any) => l.name),
    milestone: n.milestone?.title ?? null,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    comments: n.comments?.totalCount ?? 0,
    issueType: n.issueType ? { id: n.issueType.id, name: n.issueType.name } : null,
    fieldValues: isPullRequest ? [] : mapFieldValues(n.issueFieldValues?.nodes ?? []),
  };
}

export function createGitHubClient(request: GraphQLRequest): GitHubClient {
  async function pageRepos(
    root: "organization" | "user",
    login: string,
  ): Promise<RepoInfo[]> {
    const out: RepoInfo[] = [];
    let cursor: string | null = null;
    const query = `query($login:String!, $cursor:String){
      ${root}(login:$login){
        repositories(first:100, after:$cursor, ownerAffiliations:[OWNER]){ ${REPO_FIELDS} }
      }
    }`;
    do {
      const data = await request<any>(query, { login, cursor });
      const conn: Page<any> = data[root].repositories;
      out.push(...conn.nodes.map(mapRepo));
      cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    } while (cursor);
    return out;
  }

  async function pageIssues(
    owner: string,
    name: string,
    since: string | null,
    connection: "issues" | "pullRequests",
  ): Promise<FetchedIssue[]> {
    const out: FetchedIssue[] = [];
    let cursor: string | null = null;
    const nodeBody = connection === "issues" ? ISSUE_NODE : PR_NODE;
    const query = `query($owner:String!, $name:String!, $cursor:String){
      repository(owner:$owner, name:$name){
        ${connection}(first:50, after:$cursor, orderBy:{field:UPDATED_AT, direction:DESC}){
          nodes { ${nodeBody} }
          pageInfo { hasNextPage endCursor }
        }
      }
    }`;
    outer: do {
      const data = await request<any>(query, { owner, name, cursor });
      const conn: Page<any> = data.repository[connection];
      for (const node of conn.nodes) {
        if (since && node.updatedAt <= since) break outer;
        out.push(mapIssue(node, connection === "pullRequests"));
      }
      cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    } while (cursor);
    return out;
  }

  return {
    listOrgRepos: (org) => pageRepos("organization", org),
    listUserRepos: (username) => pageRepos("user", username),

    async getRepo(owner, name) {
      const data = await request<any>(
        `query($owner:String!,$name:String!){
          repository(owner:$owner,name:$name){ id name isFork isArchived owner { login } }
        }`,
        { owner, name },
      );
      return data.repository ? mapRepo(data.repository) : null;
    },

    async fetchIssuesUpdatedSince(owner, name, since) {
      const issues = await pageIssues(owner, name, since, "issues");
      const prs = await pageIssues(owner, name, since, "pullRequests");
      return [...issues, ...prs];
    },

    async discoverIssueTypes(owner, name) {
      const data = await request<any>(
        `query($owner:String!,$name:String!){
          repository(owner:$owner,name:$name){
            issueTypes(first:50){ nodes { id name color description } }
          }
        }`,
        { owner, name },
      );
      return (data.repository.issueTypes?.nodes ?? []).map((t: any) => ({
        id: t.id,
        name: t.name,
        color: t.color ?? null,
        description: t.description ?? null,
      }));
    },

    async discoverFields(owner, name) {
      const data = await request<any>(
        `query($owner:String!,$name:String!){
          repository(owner:$owner,name:$name){
            issueFields(first:50){
              nodes{
                __typename
                ... on IssueFieldSingleSelect { id name dataType options { id name color description } }
                ... on IssueFieldMultiSelect  { id name dataType options { id name color } }
                ... on IssueFieldNumber { id name dataType }
                ... on IssueFieldText   { id name dataType }
                ... on IssueFieldDate   { id name dataType }
              }
            }
          }
        }`,
        { owner, name },
      );
      return (data.repository.issueFields?.nodes ?? []).map((f: any) => ({
        id: f.id,
        name: f.name,
        dataType: normalizeDataType(f.dataType),
        options: (f.options ?? []).map((o: any, i: number) => ({
          id: o.id,
          name: o.name,
          color: o.color ?? null,
          position: i,
        })),
      }));
    },
  };
}
