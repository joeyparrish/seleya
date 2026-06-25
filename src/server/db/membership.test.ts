import { describe, it, expect } from "vitest";
import { openDatabase } from "./database.js";
import { upsertRepo } from "./repos.js";
import { replaceTabMemberships, listTabMemberships } from "./membership.js";

function seed(db: ReturnType<typeof openDatabase>) {
  for (const id of ["R_1", "R_2", "R_3"]) {
    upsertRepo(db, { id, owner: "o", name: id, isFork: false, isArchived: false });
  }
}

describe("tab membership store", () => {
  it("round-trips memberships preserving tab order", () => {
    const db = openDatabase(":memory:");
    seed(db);
    replaceTabMemberships(db, [
      { position: 0, name: "Alpha", repoIds: ["R_1", "R_2"] },
      { position: 1, name: "Beta", repoIds: ["R_3"] },
    ]);
    expect(listTabMemberships(db)).toEqual([
      { position: 0, tabName: "Alpha", repoIds: ["R_1", "R_2"] },
      { position: 1, tabName: "Beta", repoIds: ["R_3"] },
    ]);
  });

  it("fully replaces prior memberships", () => {
    const db = openDatabase(":memory:");
    seed(db);
    replaceTabMemberships(db, [{ position: 0, name: "Old", repoIds: ["R_1", "R_2", "R_3"] }]);
    replaceTabMemberships(db, [{ position: 0, name: "New", repoIds: ["R_3"] }]);
    expect(listTabMemberships(db)).toEqual([{ position: 0, tabName: "New", repoIds: ["R_3"] }]);
  });

  it("keeps non-contiguous positions when a tab is omitted", () => {
    const db = openDatabase(":memory:");
    seed(db);
    replaceTabMemberships(db, [
      { position: 0, name: "First", repoIds: ["R_1"] },
      { position: 2, name: "Third", repoIds: ["R_2"] },
    ]);
    expect(listTabMemberships(db).map((m) => m.position)).toEqual([0, 2]);
  });
});
