import { describe, it, expect } from "vitest";
import { openDatabase } from "./database.js";
import { SCHEMA_SQL } from "./schema.js";

describe("openDatabase", () => {
  it("creates all expected tables", () => {
    const db = openDatabase(":memory:");
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);
    for (const t of [
      "repos",
      "issues",
      "issue_labels",
      "issue_types",
      "field_definitions",
      "field_options",
      "issue_field_values",
      "sync_state",
    ]) {
      expect(names).toContain(t);
    }
  });

  it("enables foreign key enforcement", () => {
    const db = openDatabase(":memory:");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("is idempotent when applied twice", () => {
    const db = openDatabase(":memory:");
    expect(() => db.exec(SCHEMA_SQL)).not.toThrow();
  });
});
