import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/database.js";
import { upsertRepo } from "../db/repos.js";
import { upsertIssue, type IssueRecord } from "../db/issues.js";
import { setIssueFieldValues } from "../db/fields.js";
import { compileFilter, type CompiledFilter } from "./filter.js";

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
      labels: ["bug", "triaged"],
      assignees: ["alice"],
      author: "bob",
      milestone: "v1",
      issueTypeName: "Bug",
      createdAt: "2026-06-01T00:00:00Z", // 23 days old
    }),
  );
  upsertIssue(db, issue({ id: "I_2", repoId: "R_1", isPullRequest: true, author: "carol" }));
  upsertIssue(db, issue({ id: "I_3", repoId: "R_2", labels: ["bug"] }));

  setIssueFieldValues(db, "I_1", [
    { fieldName: "Priority", dataType: "single_select", valueText: "High", optionId: "IFSSO_1" },
    { fieldName: "Effort", dataType: "number", valueNumber: 5 },
  ]);
  setIssueFieldValues(db, "I_3", [
    { fieldName: "Priority", dataType: "single_select", valueText: "Low", optionId: "IFSSO_2" },
  ]);
});

function ids(cf: CompiledFilter): string[] {
  return (
    db.prepare(`SELECT id FROM issues WHERE ${cf.where} ORDER BY id`).all(...cf.params) as Array<{
      id: string;
    }>
  ).map((r) => r.id);
}

describe("compileFilter", () => {
  it("scopes to the given repo ids", () => {
    expect(ids(compileFilter(undefined, ["R_1"], now))).toEqual(["I_1", "I_2"]);
  });

  it("matches nothing for an empty repo set", () => {
    const cf = compileFilter(undefined, [], now);
    expect(cf).toEqual({ where: "0", params: [] });
    expect(ids(cf)).toEqual([]);
  });

  it("filters pull requests by type", () => {
    expect(ids(compileFilter({ type: "pull_request" }, ["R_1", "R_2"], now))).toEqual(["I_2"]);
  });

  it("requires all included labels", () => {
    expect(ids(compileFilter({ labelsInclude: ["bug", "triaged"] }, ["R_1", "R_2"], now))).toEqual([
      "I_1",
    ]);
  });

  it("excludes issues carrying an excluded label", () => {
    expect(ids(compileFilter({ labelsExclude: ["triaged"] }, ["R_1", "R_2"], now))).toEqual([
      "I_2",
      "I_3",
    ]);
  });

  it("matches an assignee in the JSON array", () => {
    expect(ids(compileFilter({ assignee: "alice" }, ["R_1", "R_2"], now))).toEqual(["I_1"]);
  });

  it("filters by issue type name", () => {
    expect(ids(compileFilter({ issueType: ["Bug"] }, ["R_1", "R_2"], now))).toEqual(["I_1"]);
  });

  it("filters by age in days", () => {
    expect(ids(compileFilter({ ageDays: { op: ">=", value: 7 } }, ["R_1", "R_2"], now))).toEqual([
      "I_1",
    ]);
  });

  it("filters by a single-select field value", () => {
    expect(
      ids(compileFilter({ fields: [{ name: "Priority", in: ["High"] }] }, ["R_1", "R_2"], now)),
    ).toEqual(["I_1"]);
  });

  it("excludes field values with notIn, and issues lacking the field still match", () => {
    expect(
      ids(compileFilter({ fields: [{ name: "Priority", notIn: ["High"] }] }, ["R_1", "R_2"], now)),
    ).toEqual(["I_2", "I_3"]);
  });

  it("combines in and notIn on the same field", () => {
    expect(
      ids(
        compileFilter(
          { fields: [{ name: "Priority", in: ["High", "Low"], notIn: ["Low"] }] },
          ["R_1", "R_2"],
          now,
        ),
      ),
    ).toEqual(["I_1"]);
  });

  it("filters by a numeric field comparison", () => {
    expect(
      ids(compileFilter({ fields: [{ name: "Effort", op: ">=", value: 3 }] }, ["R_1", "R_2"], now)),
    ).toEqual(["I_1"]);
  });

  it("selects issues lacking a field when unset is set", () => {
    expect(
      ids(compileFilter({ fields: [{ name: "Priority", unset: true }] }, ["R_1", "R_2"], now)),
    ).toEqual(["I_2"]);
  });

  it("matches labels case-insensitively by default", () => {
    expect(ids(compileFilter({ labelsInclude: ["BUG"] }, ["R_1", "R_2"], now))).toEqual([
      "I_1",
      "I_3",
    ]);
  });

  it("matches field name and value case-insensitively by default", () => {
    expect(
      ids(compileFilter({ fields: [{ name: "priority", in: ["high"] }] }, ["R_1", "R_2"], now)),
    ).toEqual(["I_1"]);
  });

  it("is exact when caseSensitive is true", () => {
    expect(ids(compileFilter({ labelsInclude: ["BUG"] }, ["R_1", "R_2"], now, true))).toEqual([]);
    expect(ids(compileFilter({ labelsInclude: ["bug"] }, ["R_1", "R_2"], now, true))).toEqual([
      "I_1",
      "I_3",
    ]);
  });
});
