import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/database.js";
import { upsertRepo } from "../db/repos.js";
import { upsertIssue, type IssueRecord } from "../db/issues.js";
import { setIssueFieldValues } from "../db/fields.js";
import { compileFilter, type CompiledFilter } from "./filter.js";
import type { GroupFilter } from "../config/schema.js";

const now = new Date("2026-06-24T00:00:00Z");

function issue(over: Partial<IssueRecord> & Pick<IssueRecord, "id" | "repoId">): IssueRecord {
  return {
    number: 1,
    title: "t",
    isPullRequest: false,
    state: "OPEN",
    author: null,
    assignees: [],
    labels: [],
    milestone: null,
    createdAt: "2026-06-23T00:00:00Z",
    updatedAt: "2026-06-23T00:00:00Z",
    comments: 0,
    issueTypeId: null,
    issueTypeName: null,
    ...over,
  };
}

let db: Database.Database;

beforeEach(() => {
  db = openDatabase(":memory:");
  upsertRepo(db, { id: "R_1", owner: "o", name: "n", isFork: false });
  upsertRepo(db, { id: "R_2", owner: "o", name: "m", isFork: false });

  upsertIssue(
    db,
    issue({
      id: "I_1",
      repoId: "R_1",
      labels: [
        { name: "bug", color: "d73a4a" },
        { name: "triaged", color: null },
      ],
      assignees: ["alice", "bob"],
      author: "Octocat",
      milestone: "v1",
      issueTypeName: "Bug",
      createdAt: "2026-06-01T00:00:00Z", // 23 days old
    }),
  );
  upsertIssue(db, issue({ id: "I_2", repoId: "R_1", isPullRequest: true, author: "dependabot" }));
  upsertIssue(
    db,
    issue({
      id: "I_3",
      repoId: "R_2",
      labels: [{ name: "bug", color: "d73a4a" }],
      assignees: ["carol"],
      author: "alice",
      milestone: "v2",
      issueTypeName: "Task",
    }),
  );

  setIssueFieldValues(db, "I_1", [
    { fieldName: "Priority", dataType: "single_select", valueText: "High", optionId: "IFSSO_1" },
    { fieldName: "Effort", dataType: "number", valueNumber: 5 },
  ]);
  setIssueFieldValues(db, "I_3", [
    { fieldName: "Priority", dataType: "single_select", valueText: "Low", optionId: "IFSSO_2" },
  ]);
});

const ALL = ["R_1", "R_2"];

function ids(cf: CompiledFilter): string[] {
  return (
    db.prepare(`SELECT id FROM issues WHERE ${cf.where} ORDER BY id`).all(...cf.params) as Array<{
      id: string;
    }>
  ).map((r) => r.id);
}

function run(filter: GroupFilter, repos = ALL, caseSensitive = false): string[] {
  return ids(compileFilter(filter, repos, now, caseSensitive));
}

describe("compileFilter", () => {
  it("scopes to repo ids and matches nothing for an empty set", () => {
    expect(ids(compileFilter(undefined, ["R_1"], now))).toEqual(["I_1", "I_2"]);
    expect(compileFilter(undefined, [], now)).toEqual({ where: "0", params: [] });
  });

  it("filters pull requests by type", () => {
    expect(run({ type: "pull_request" })).toEqual(["I_2"]);
  });

  describe("labels (set dimension)", () => {
    it("include is any-of", () => {
      expect(run({ labels: { include: ["bug"] } })).toEqual(["I_1", "I_3"]);
    });
    it("a list of matchers is ANDed (requires all)", () => {
      expect(run({ labels: [{ include: ["bug"] }, { include: ["triaged"] }] })).toEqual(["I_1"]);
    });
    it("exclude removes any with the label (no labels also matches)", () => {
      expect(run({ labels: { exclude: ["triaged"] } })).toEqual(["I_2", "I_3"]);
    });
    it("set:false matches issues with no labels", () => {
      expect(run({ labels: { set: false } })).toEqual(["I_2"]);
    });
    it("a single matcher object behaves like a one-element list", () => {
      expect(run({ labels: { include: ["triaged"] } })).toEqual(
        run({ labels: [{ include: ["triaged"] }] }),
      );
    });
  });

  describe("assignees (set dimension)", () => {
    it("include matches an assignee", () => {
      expect(run({ assignee: { include: ["alice"] } })).toEqual(["I_1"]);
    });
    it("set:false matches unassigned issues", () => {
      expect(run({ assignee: { set: false } })).toEqual(["I_2"]);
    });
  });

  describe("author / milestone / issueType (scalar dimensions)", () => {
    it("is matches case-insensitively by default", () => {
      expect(run({ author: { is: "octocat" } })).toEqual(["I_1"]);
    });
    it("like does a fuzzy match", () => {
      expect(run({ author: { like: "%bot%" } })).toEqual(["I_2"]);
    });
    it("exclude treats a missing value as not-in", () => {
      expect(run({ author: { exclude: ["alice"] } })).toEqual(["I_1", "I_2"]);
    });
    it("milestone set:false matches a missing milestone", () => {
      expect(run({ milestone: { set: false } })).toEqual(["I_2"]);
    });
    it("issueType include is any-of", () => {
      expect(run({ issueType: { include: ["Bug", "Task"] } })).toEqual(["I_1", "I_3"]);
    });
  });

  describe("age (numeric dimension)", () => {
    it("gte selects older issues", () => {
      expect(run({ age: { gte: 7 } })).toEqual(["I_1"]);
    });
    it("lt selects newer issues", () => {
      expect(run({ age: { lt: 7 } })).toEqual(["I_2", "I_3"]);
    });
  });

  describe("fields", () => {
    it("include matches a select value (case-insensitive)", () => {
      expect(run({ fields: [{ name: "priority", include: ["high"] }] })).toEqual(["I_1"]);
    });
    it("exclude removes matching values (no value also matches)", () => {
      expect(run({ fields: [{ name: "Priority", exclude: ["Low"] }] })).toEqual(["I_1", "I_2"]);
    });
    it("numeric comparison on a number field", () => {
      expect(run({ fields: [{ name: "Effort", gte: 3 }] })).toEqual(["I_1"]);
    });
    it("set:false matches issues without that field", () => {
      expect(run({ fields: [{ name: "Priority", set: false }] })).toEqual(["I_2"]);
      expect(run({ fields: [{ name: "Department", set: false }] })).toEqual(["I_1", "I_2", "I_3"]);
    });
  });

  describe("case sensitivity", () => {
    it("is is exact when caseSensitive is true", () => {
      expect(run({ author: { is: "octocat" } }, ALL, true)).toEqual([]);
      expect(run({ author: { is: "Octocat" } }, ALL, true)).toEqual(["I_1"]);
    });
    it("like stays case-insensitive even when caseSensitive is true", () => {
      expect(run({ author: { like: "%BOT%" } }, ALL, true)).toEqual(["I_2"]);
    });
  });

  it("ANDs conditions across dimensions", () => {
    expect(run({ type: "issue", labels: { include: ["bug"] }, age: { gte: 7 } })).toEqual(["I_1"]);
  });
});
