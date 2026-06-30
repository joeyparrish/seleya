import { describe, it, expect } from "vitest";
import { openDatabase } from "./database.js";
import { upsertRepo } from "./repos.js";
import {
  upsertIssue,
  deleteIssue,
  getIssue,
  listIssueIdsByRepo,
  type IssueRecord,
} from "./issues.js";

function seedRepo(db: ReturnType<typeof openDatabase>) {
  upsertRepo(db, { id: "R_1", owner: "o", name: "n", isFork: false });
}

const base: IssueRecord = {
  id: "I_1",
  repoId: "R_1",
  number: 7,
  title: "Bug",
  isPullRequest: false,
  state: "OPEN",
  author: "alice",
  assignees: ["bob"],
  labels: [
    { name: "bug", color: "d73a4a" },
    { name: "triaged", color: null },
  ],
  milestone: "v1",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  comments: 3,
  issueTypeId: "IT_1",
  issueTypeName: "Bug",
};

describe("issue store", () => {
  it("round-trips an issue with labels and assignees", () => {
    const db = openDatabase(":memory:");
    seedRepo(db);
    upsertIssue(db, base);
    expect(getIssue(db, "I_1")).toEqual(base);
  });

  it("replaces labels on re-upsert rather than accumulating", () => {
    const db = openDatabase(":memory:");
    seedRepo(db);
    upsertIssue(db, base);
    upsertIssue(db, { ...base, labels: [{ name: "wontfix", color: "ffffff" }] });
    expect(getIssue(db, "I_1")?.labels).toEqual([{ name: "wontfix", color: "ffffff" }]);
  });

  it("deletes an issue and cascades its labels", () => {
    const db = openDatabase(":memory:");
    seedRepo(db);
    upsertIssue(db, base);
    deleteIssue(db, "I_1");
    expect(getIssue(db, "I_1")).toBeUndefined();
    const labelCount = db
      .prepare("SELECT COUNT(*) AS c FROM issue_labels WHERE issue_id='I_1'")
      .get() as { c: number };
    expect(labelCount.c).toBe(0);
  });

  it("lists issue ids for a repo", () => {
    const db = openDatabase(":memory:");
    seedRepo(db);
    upsertIssue(db, base);
    upsertIssue(db, { ...base, id: "I_2", number: 8 });
    expect(listIssueIdsByRepo(db, "R_1").sort()).toEqual(["I_1", "I_2"]);
  });
});
