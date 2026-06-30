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

/**
 * Applies a batch of fetched items to the store: open items are upserted (with
 * their type and field values), non-open items are deleted. Returns the set of
 * open issue ids seen, which the deep-refresh reconciler uses to detect local
 * issues that have vanished upstream.
 */
export function applyFetchedIssues(
  db: Database.Database,
  repoId: string,
  fetched: FetchedIssue[],
): Set<string> {
  const openIds = new Set<string>();
  for (const f of fetched) {
    if (f.state === "OPEN") {
      if (f.issueType) {
        upsertIssueType(db, {
          id: f.issueType.id,
          name: f.issueType.name,
          color: f.issueType.color,
          description: null,
        });
      }
      upsertIssue(db, toRecord(repoId, f));
      setIssueFieldValues(db, f.id, f.fieldValues as IssueFieldValue[]);
      openIds.add(f.id);
    } else {
      deleteIssue(db, f.id);
    }
  }
  return openIds;
}

export async function syncRepo(
  db: Database.Database,
  client: GitHubClient,
  repo: RepoInfo,
  opts?: { now?: Date; rediscover?: boolean },
): Promise<void> {
  const now = opts?.now ?? new Date();
  setSyncState(db, repo.id, { status: "syncing", error: null });
  try {
    const since = getSyncState(db, repo.id)?.lastSyncedAt ?? null;

    // Type/field definitions change rarely, so discover them on a repo's first
    // sync (or when explicitly asked, e.g. a deep refresh) rather than on every
    // incremental sync. This removes two GraphQL round-trips per repo per sync.
    if (since === null || opts?.rediscover) {
      for (const t of await client.discoverIssueTypes(repo.owner, repo.name)) {
        upsertIssueType(db, t);
      }
      for (const f of await client.discoverFields(repo.owner, repo.name)) {
        upsertFieldDefinition(db, { ...f, repoId: repo.id });
      }
    }

    const fetched = await client.fetchIssuesUpdatedSince(repo.owner, repo.name, since);
    applyFetchedIssues(db, repo.id, fetched);

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
  opts?: {
    force?: boolean;
    now?: Date;
    concurrency?: number;
    rediscover?: boolean;
    onRepoStart?: (repo: RepoInfo) => void;
    onRepoDone?: (repo: RepoInfo, state: SyncStateRow | undefined) => void;
  },
): Promise<void> {
  const now = opts?.now ?? new Date();
  const due = repos.filter(
    (repo) => opts?.force || isStale(getSyncState(db, repo.id), ttlMinutes, now),
  );
  // Each syncRepo isolates its own errors (it never throws), so one failing repo
  // does not sink the batch. Concurrency is bounded to stay within GitHub's
  // secondary rate limits.
  const workerCount = Math.max(1, Math.min(opts?.concurrency ?? 6, due.length));

  let next = 0;
  async function worker(): Promise<void> {
    while (next < due.length) {
      const repo = due[next++];
      if (!repo) break;
      opts?.onRepoStart?.(repo);
      await syncRepo(db, client, repo, { now, rediscover: opts?.rediscover });
      opts?.onRepoDone?.(repo, getSyncState(db, repo.id));
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}
