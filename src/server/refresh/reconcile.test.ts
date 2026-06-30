import { describe, it, expect } from "vitest";
import { openDatabase } from "../db/database.js";
import { upsertRepo } from "../db/repos.js";
import { getIssue, listIssueIdsByRepo } from "../db/issues.js";
import { reconcileRepoIssues } from "./reconcile.js";
import type { GitHubClient } from "../github/client.js";
import type { FetchedIssue, RepoInfo } from "../github/types.js";

const repo: RepoInfo = { id: "R_1", owner: "o", name: "n", isFork: false, isArchived: false };

function fakeClient(fetched: FetchedIssue[]): GitHubClient {
  return {
    listOrgRepos: async () => [],
    listUserRepos: async () => [],
    getRepo: async () => null,
    fetchIssuesUpdatedSince: async () => [],
    fetchOpenIssues: async () => fetched,
    discoverIssueTypes: async () => [],
    discoverFields: async () => [],
  };
}

function open(id: string, number: number): FetchedIssue {
  return {
    id,
    number,
    title: `#${number}`,
    isPullRequest: false,
    state: "OPEN",
    author: null,
    assignees: [],
    labels: [],
    milestone: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    comments: 0,
    issueType: null,
    fieldValues: [],
  };
}

describe("reconcileRepoIssues", () => {
  it("deletes local issues absent from the full fetch and inserts new open ones", async () => {
    const db = openDatabase(":memory:");
    upsertRepo(db, repo);

    // Seed two open issues via an initial reconcile.
    await reconcileRepoIssues(db, fakeClient([open("I_1", 1), open("I_2", 2)]), repo);
    expect(listIssueIdsByRepo(db, "R_1").sort()).toEqual(["I_1", "I_2"]);

    // Upstream now has I_2 (still open) and a new I_3; I_1 has vanished.
    await reconcileRepoIssues(db, fakeClient([open("I_2", 2), open("I_3", 3)]), repo);
    expect(listIssueIdsByRepo(db, "R_1").sort()).toEqual(["I_2", "I_3"]);
    expect(getIssue(db, "I_1")).toBeUndefined();
  });
});
