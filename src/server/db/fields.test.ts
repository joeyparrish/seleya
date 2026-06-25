import { describe, it, expect } from "vitest";
import { openDatabase } from "./database.js";
import { upsertRepo } from "./repos.js";
import { upsertIssue, type IssueRecord } from "./issues.js";
import {
  upsertIssueType,
  upsertFieldDefinition,
  setIssueFieldValues,
  getFieldValues,
  listFieldDefinitions,
  type IssueFieldValue,
} from "./fields.js";

function seed(db: ReturnType<typeof openDatabase>) {
  upsertRepo(db, { id: "R_1", owner: "o", name: "n", isFork: false });
  const issue: IssueRecord = {
    id: "I_1", repoId: "R_1", number: 1, title: "t", isPullRequest: false, state: "OPEN",
    author: null, assignees: [], labels: [], milestone: null,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    comments: 0, issueTypeId: null, issueTypeName: null,
  };
  upsertIssue(db, issue);
}

describe("field store", () => {
  it("stores a field definition with options", () => {
    const db = openDatabase(":memory:");
    seed(db);
    upsertFieldDefinition(db, {
      id: "IFSS_1", repoId: "R_1", name: "Priority", dataType: "single_select",
      options: [
        { id: "IFSSO_1", name: "High", color: "RED", position: 0 },
        { id: "IFSSO_2", name: "Low", color: "GREEN", position: 1 },
      ],
    });
    const defs = listFieldDefinitions(db);
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("Priority");
    expect(defs[0].options.map((o) => o.name)).toEqual(["High", "Low"]);
  });

  it("replaces options on re-upsert", () => {
    const db = openDatabase(":memory:");
    seed(db);
    const def = (opts: any) => ({
      id: "IFSS_1", repoId: "R_1", name: "Priority", dataType: "single_select" as const, options: opts,
    });
    upsertFieldDefinition(db, def([{ id: "IFSSO_1", name: "High", color: null, position: 0 }]));
    upsertFieldDefinition(db, def([{ id: "IFSSO_2", name: "Low", color: null, position: 0 }]));
    expect(listFieldDefinitions(db)[0].options.map((o) => o.name)).toEqual(["Low"]);
  });

  it("replaces issue field values and reads them back", () => {
    const db = openDatabase(":memory:");
    seed(db);
    const values: IssueFieldValue[] = [
      { fieldName: "Priority", dataType: "single_select", valueText: "High", optionId: "IFSSO_1" },
      { fieldName: "Effort", dataType: "number", valueNumber: 5 },
    ];
    setIssueFieldValues(db, "I_1", values);
    setIssueFieldValues(db, "I_1", [
      { fieldName: "Priority", dataType: "single_select", valueText: "Low", optionId: "IFSSO_2" },
    ]);
    const back = getFieldValues(db, "I_1");
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ fieldName: "Priority", valueText: "Low", optionId: "IFSSO_2" });
  });

  it("stores an issue type", () => {
    const db = openDatabase(":memory:");
    seed(db);
    upsertIssueType(db, { id: "IT_1", name: "Bug", color: "RED", description: null });
    const row = db.prepare("SELECT name FROM issue_types WHERE id='IT_1'").get() as { name: string };
    expect(row.name).toBe("Bug");
  });
});
