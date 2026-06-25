import type Database from "better-sqlite3";
import type { GitHubClient } from "../github/client.js";
import type { FetchedIssue, RepoInfo } from "../github/types.js";
import { upsertIssue, deleteIssue, type IssueRecord } from "../db/issues.js";
import {
  upsertFieldDefinition,
  upsertIssueType,
  setIssueFieldValues,
  type IssueFieldValue,
} from "../db/fields.js";
import { getSyncState, setSyncState, type SyncStateRow } from "../db/syncState.js";

export function isStale(
  state: SyncStateRow | undefined,
  ttlMinutes: number,
  now: Date,
): boolean {
  if (!state?.lastSyncedAt) return true;
  const age = now.getTime() - new Date(state.lastSyncedAt).getTime();
  return age >= ttlMinutes * 60_000;
}

function toRecord(repoId: string, f: FetchedIssue): IssueRecord {
  return {
    id: f.id,
    repoId,
    number: f.number,
    title: f.title,
    isPullRequest: f.isPullRequest,
    state: f.state,
    author: f.author,
    assignees: f.assignees,
    labels: f.labels,
    milestone: f.milestone,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
    comments: f.comments,
    issueTypeId: f.issueType?.id ?? null,
    issueTypeName: f.issueType?.name ?? null,
  };
}

export async function syncRepo(
  db: Database.Database,
  client: GitHubClient,
  repo: RepoInfo,
  opts?: { now?: Date },
): Promise<void> {
  const now = opts?.now ?? new Date();
  setSyncState(db, repo.id, { status: "syncing", error: null });
  try {
    for (const t of await client.discoverIssueTypes(repo.owner, repo.name)) {
      upsertIssueType(db, t);
    }
    for (const f of await client.discoverFields(repo.owner, repo.name)) {
      upsertFieldDefinition(db, { ...f, repoId: repo.id });
    }

    const since = getSyncState(db, repo.id)?.lastSyncedAt ?? null;
    const fetched = await client.fetchIssuesUpdatedSince(repo.owner, repo.name, since);

    for (const f of fetched) {
      if (f.state === "OPEN") {
        if (f.issueType) {
          upsertIssueType(db, {
            id: f.issueType.id,
            name: f.issueType.name,
            color: null,
            description: null,
          });
        }
        upsertIssue(db, toRecord(repo.id, f));
        setIssueFieldValues(db, f.id, f.fieldValues as IssueFieldValue[]);
      } else {
        deleteIssue(db, f.id);
      }
    }

    setSyncState(db, repo.id, {
      status: "idle",
      error: null,
      lastSyncedAt: now.toISOString(),
    });
  } catch (err) {
    setSyncState(db, repo.id, {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function syncStaleRepos(
  db: Database.Database,
  client: GitHubClient,
  repos: RepoInfo[],
  ttlMinutes: number,
  opts?: { force?: boolean; now?: Date },
): Promise<void> {
  const now = opts?.now ?? new Date();
  for (const repo of repos) {
    if (!opts?.force && !isStale(getSyncState(db, repo.id), ttlMinutes, now)) continue;
    await syncRepo(db, client, repo, { now });
  }
}
