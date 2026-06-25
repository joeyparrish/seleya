import { describe, it, expect, vi } from "vitest";
import { openDatabase } from "../db/database.js";
import { upsertRepo } from "../db/repos.js";
import { getIssue } from "../db/issues.js";
import { getSyncState } from "../db/syncState.js";
import { getFieldValues } from "../db/fields.js";
import { isStale, syncRepo, syncStaleRepos } from "./engine.js";
import type { GitHubClient } from "../github/client.js";
import type { FetchedIssue, RepoInfo } from "../github/types.js";

const repo: RepoInfo = { id: "R_1", owner: "o", name: "n", isFork: false, isArchived: false };

function fakeClient(over: Partial<GitHubClient>): GitHubClient {
  return {
    listOrgRepos: async () => [],
    listUserRepos: async () => [],
    fetchIssuesUpdatedSince: async () => [],
    discoverIssueTypes: async () => [],
    discoverFields: async () => [],
    getRepo: async (owner: string, name: string) => null,
    ...over,
  };
}

const openIssue: FetchedIssue = {
  id: "I_1", number: 1, title: "open", isPullRequest: false, state: "OPEN",
  author: "a", assignees: [], labels: ["bug"], milestone: null,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z",
  comments: 0, issueType: { id: "IT_1", name: "Bug" },
  fieldValues: [{ fieldName: "Priority", dataType: "single_select", valueText: "High", optionId: "IFSSO_1" }],
};

describe("isStale", () => {
  const now = new Date("2026-01-01T01:00:00Z");
  it("is stale when never synced", () => {
    expect(isStale(undefined, 10, now)).toBe(true);
  });
  it("is stale when older than the TTL", () => {
    expect(isStale({ repoId: "R_1", lastSyncedAt: "2026-01-01T00:40:00Z", status: "idle", error: null }, 10, now)).toBe(true);
  });
  it("is fresh within the TTL", () => {
    expect(isStale({ repoId: "R_1", lastSyncedAt: "2026-01-01T00:55:00Z", status: "idle", error: null }, 10, now)).toBe(false);
  });
});

describe("syncRepo", () => {
  it("upserts an open issue with field values and marks the repo synced", async () => {
    const db = openDatabase(":memory:");
    upsertRepo(db, repo);
    const client = fakeClient({ fetchIssuesUpdatedSince: async () => [openIssue] });
    await syncRepo(db, client, repo, { now: new Date("2026-01-02T01:00:00Z") });

    expect(getIssue(db, "I_1")?.title).toBe("open");
    expect(getFieldValues(db, "I_1")[0].valueText).toBe("High");
    const state = getSyncState(db, "R_1");
    expect(state?.status).toBe("idle");
    expect(state?.lastSyncedAt).toBe("2026-01-02T01:00:00.000Z");
  });

  it("removes an issue that is no longer open", async () => {
    const db = openDatabase(":memory:");
    upsertRepo(db, repo);
    await syncRepo(db, fakeClient({ fetchIssuesUpdatedSince: async () => [openIssue] }), repo);
    await syncRepo(
      db,
      fakeClient({ fetchIssuesUpdatedSince: async () => [{ ...openIssue, state: "CLOSED" }] }),
      repo,
    );
    expect(getIssue(db, "I_1")).toBeUndefined();
  });

  it("records an error and does not throw", async () => {
    const db = openDatabase(":memory:");
    upsertRepo(db, repo);
    const client = fakeClient({
      fetchIssuesUpdatedSince: async () => {
        throw new Error("rate limited");
      },
    });
    await syncRepo(db, client, repo);
    const state = getSyncState(db, "R_1");
    expect(state?.status).toBe("error");
    expect(state?.error).toMatch(/rate limited/);
  });
});

describe("syncStaleRepos", () => {
  it("skips fresh repos unless forced", async () => {
    const db = openDatabase(":memory:");
    upsertRepo(db, repo);
    const fetch = vi.fn(async () => [] as FetchedIssue[]);
    const client = fakeClient({ fetchIssuesUpdatedSince: fetch });
    await syncStaleRepos(db, client, [repo], 10, { now: new Date("2026-01-02T00:00:00Z") });
    expect(fetch).toHaveBeenCalledTimes(1); // first sync (was stale)
    await syncStaleRepos(db, client, [repo], 10, { now: new Date("2026-01-02T00:01:00Z") });
    expect(fetch).toHaveBeenCalledTimes(1); // still fresh -> skipped
    await syncStaleRepos(db, client, [repo], 10, { force: true, now: new Date("2026-01-02T00:01:00Z") });
    expect(fetch).toHaveBeenCalledTimes(2); // forced
  });
});
