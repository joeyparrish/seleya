import { describe, it, expect, vi } from "vitest";
import { openDatabase } from "../db/database.js";
import { upsertRepo, getRepo, listRepos } from "../db/repos.js";
import { upsertIssue, getIssue, type IssueRecord } from "../db/issues.js";
import { getSyncState } from "../db/syncState.js";
import { listTabMemberships } from "../db/membership.js";
import { RefreshController } from "./orchestrator.js";
import type { Config } from "../config/schema.js";
import type { GitHubClient } from "../github/client.js";
import type { RepoInfo } from "../github/types.js";

function repoInfo(id: string, name: string): RepoInfo {
  return { id, owner: "o", name, isFork: false, isArchived: false };
}

function fakeClient(over: Partial<GitHubClient> = {}): GitHubClient {
  return {
    listOrgRepos: async () => [],
    listUserRepos: async () => [],
    getRepo: async () => null,
    fetchIssuesUpdatedSince: async () => [],
    discoverIssueTypes: async () => [],
    discoverFields: async () => [],
    ...over,
  };
}

function makeConfig(over: Partial<Config>): Config {
  return {
    username: "o",
    ttlMinutes: 10,
    syncConcurrency: 6,
    caseSensitive: false,
    bindAddress: "127.0.0.1",
    port: 8080,
    allowedHosts: [],
    forkAllowlist: [],
    tabs: [],
    ...over,
  };
}

const orgTab = makeConfig({ tabs: [{ name: "Org", match: [{ org: "o" }] }] });

describe("RefreshController", () => {
  it("resolves, persists membership, upserts repos, and syncs", async () => {
    const db = openDatabase(":memory:");
    const client = fakeClient({ listOrgRepos: async () => [repoInfo("R_1", "a"), repoInfo("R_2", "b")] });
    const c = new RefreshController(db, client, orgTab);

    await c.refresh();

    expect(listRepos(db).map((r) => r.id).sort()).toEqual(["R_1", "R_2"]);
    expect(listTabMemberships(db)).toEqual([
      { position: 0, tabName: "Org", repoIds: ["R_1", "R_2"] },
    ]);
    expect(getSyncState(db, "R_1")?.status).toBe("idle");

    const s = c.getStatus();
    expect(s).toMatchObject({ running: false, total: 2, completed: 2, errors: 0, lastError: null });
  });

  it("deletes repos that left the match set, cascading their issues", async () => {
    const db = openDatabase(":memory:");
    upsertRepo(db, repoInfo("R_old", "old"));
    const stale: IssueRecord = {
      id: "I_old", repoId: "R_old", number: 1, title: "t", isPullRequest: false, state: "OPEN",
      author: null, assignees: [], labels: [], milestone: null,
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      comments: 0, issueTypeId: null, issueTypeName: null,
    };
    upsertIssue(db, stale);

    const client = fakeClient({ listOrgRepos: async () => [repoInfo("R_1", "a")] });
    await new RefreshController(db, client, orgTab).refresh();

    expect(getRepo(db, "o", "old")).toBeUndefined();
    expect(getIssue(db, "I_old")).toBeUndefined();
    expect(listRepos(db).map((r) => r.id)).toEqual(["R_1"]);
  });

  it("a forced refresh re-syncs fresh repos; an unforced one respects the TTL", async () => {
    const db = openDatabase(":memory:");
    const fetch = vi.fn(async () => []);
    const client = fakeClient({
      listOrgRepos: async () => [repoInfo("R_1", "a")],
      fetchIssuesUpdatedSince: fetch,
    });
    const c = new RefreshController(db, client, orgTab);

    await c.refresh({ now: new Date("2026-01-01T00:00:00Z") }); // first sync (stale)
    expect(fetch).toHaveBeenCalledTimes(1);

    await c.refresh({ now: new Date("2026-01-01T00:01:00Z") }); // fresh, unforced -> skipped
    expect(fetch).toHaveBeenCalledTimes(1);

    await c.refresh({ force: true, now: new Date("2026-01-01T00:01:00Z") }); // forced -> re-sync
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("is single-flight: a concurrent refresh is a no-op", async () => {
    const db = openDatabase(":memory:");
    const listOrgRepos = vi.fn(async () => [repoInfo("R_1", "a")]);
    const c = new RefreshController(db, fakeClient({ listOrgRepos }), orgTab);

    const p1 = c.refresh();
    const p2 = c.refresh();
    await Promise.all([p1, p2]);

    expect(listOrgRepos).toHaveBeenCalledTimes(1);
  });
});
