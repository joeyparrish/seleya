import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/database.js";
import { upsertRepo } from "../db/repos.js";
import { upsertIssue, type IssueRecord } from "../db/issues.js";
import { upsertFieldDefinition, setIssueFieldValues } from "../db/fields.js";
import { replaceTabMemberships } from "../db/membership.js";
import { assembleTab, assembleAllTabs } from "./assemble.js";
import type { Config, Tab } from "../config/schema.js";

const now = new Date("2026-06-24T00:00:00Z");

function issue(over: Partial<IssueRecord> & Pick<IssueRecord, "id" | "repoId" | "number">): IssueRecord {
  return {
    title: "t",
    isPullRequest: false,
    state: "OPEN",
    author: null,
    assignees: [],
    labels: [],
    milestone: null,
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-20T00:00:00Z",
    comments: 0,
    issueTypeId: null,
    issueTypeName: null,
    ...over,
  };
}

const membership = { position: 0, tabName: "T", repoIds: ["R_1", "R_2"] };

let db: Database.Database;

beforeEach(() => {
  db = openDatabase(":memory:");
  upsertRepo(db, { id: "R_1", owner: "o", name: "n", isFork: false, isArchived: false });
  upsertRepo(db, { id: "R_2", owner: "o", name: "m", isFork: false, isArchived: false });

  upsertIssue(db, issue({ id: "I_1", repoId: "R_1", number: 1, labels: ["bug"], updatedAt: "2026-06-20T00:00:00Z" }));
  upsertIssue(db, issue({ id: "I_2", repoId: "R_1", number: 2, isPullRequest: true, updatedAt: "2026-06-22T00:00:00Z" }));
  upsertIssue(db, issue({ id: "I_3", repoId: "R_2", number: 3, updatedAt: "2026-06-21T00:00:00Z" }));

  upsertFieldDefinition(db, {
    id: "IFSS_1",
    repoId: "R_1",
    name: "Priority",
    dataType: "single_select",
    options: [{ id: "IFSSO_1", name: "High", color: "RED", position: 0 }],
  });
  setIssueFieldValues(db, "I_1", [
    { fieldName: "Priority", dataType: "single_select", valueText: "High", optionId: "IFSSO_1" },
  ]);
});

const tab = (over: Partial<Tab>): Tab => ({ name: "T", match: [{ org: "o" }], ...over });

describe("assembleTab", () => {
  it("produces a single implicit group ordered by updated_at desc when no groups are configured", () => {
    const view = assembleTab(db, membership, tab({}), now);
    expect(view.groups).toHaveLength(1);
    expect(view.groups[0].name).toBe("All open issues and PRs");
    expect(view.groups[0].issues.map((i) => i.id)).toEqual(["I_2", "I_3", "I_1"]);
  });

  it("partitions issues across configured groups", () => {
    const view = assembleTab(
      db,
      membership,
      tab({
        groups: [
          { name: "PRs", filter: { type: "pull_request" } },
          { name: "Issues", filter: { type: "issue" } },
        ],
      }),
      now,
    );
    expect(view.groups[0].issues.map((i) => i.id)).toEqual(["I_2"]);
    expect(view.groups[1].issues.map((i) => i.id)).toEqual(["I_3", "I_1"]);
  });

  it("builds issue and pull URLs", () => {
    const view = assembleTab(db, membership, tab({}), now);
    const byId = Object.fromEntries(view.groups[0].issues.map((i) => [i.id, i.url]));
    expect(byId["I_1"]).toBe("https://github.com/o/n/issues/1");
    expect(byId["I_2"]).toBe("https://github.com/o/n/pull/2");
  });

  it("attaches field values with option colors", () => {
    const view = assembleTab(db, membership, tab({}), now);
    const i1 = view.groups[0].issues.find((i) => i.id === "I_1")!;
    expect(i1.fields).toEqual([
      { name: "Priority", dataType: "single_select", value: "High", optionColor: "RED" },
    ]);
  });
});

describe("assembleAllTabs", () => {
  it("maps each persisted membership to its config tab by position", () => {
    const config: Config = {
      username: "o",
      ttlMinutes: 10,
      syncConcurrency: 6,
      bindAddress: "127.0.0.1",
      port: 8080,
      forkAllowlist: [],
      tabs: [tab({ name: "First" }), tab({ name: "Second" })],
    };
    replaceTabMemberships(db, [
      { position: 0, name: "First", repoIds: ["R_1"] },
      { position: 1, name: "Second", repoIds: ["R_2"] },
    ]);
    expect(assembleAllTabs(db, config, now).map((t) => t.name)).toEqual(["First", "Second"]);
  });
});
