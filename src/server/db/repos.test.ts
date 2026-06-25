import { describe, it, expect } from "vitest";
import { openDatabase } from "./database.js";
import { upsertRepo, getRepo, listRepos } from "./repos.js";

describe("repo store", () => {
  it("inserts and reads a repo", () => {
    const db = openDatabase(":memory:");
    upsertRepo(db, { id: "R_1", owner: "shaka-project", name: "shaka-player", isFork: false });
    expect(getRepo(db, "shaka-project", "shaka-player")).toEqual({
      id: "R_1",
      owner: "shaka-project",
      name: "shaka-player",
      isFork: false,
    });
  });

  it("updates on conflicting id", () => {
    const db = openDatabase(":memory:");
    upsertRepo(db, { id: "R_1", owner: "o", name: "n", isFork: false });
    upsertRepo(db, { id: "R_1", owner: "o", name: "n", isFork: true });
    expect(getRepo(db, "o", "n")?.isFork).toBe(true);
    expect(listRepos(db)).toHaveLength(1);
  });
});
