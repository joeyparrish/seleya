import { describe, it, expect } from "vitest";
import { openDatabase } from "./database.js";
import { upsertRepo } from "./repos.js";
import { getSyncState, setSyncState, listSyncStates } from "./syncState.js";

function seed(db: ReturnType<typeof openDatabase>) {
  upsertRepo(db, { id: "R_1", owner: "o", name: "n", isFork: false });
}

describe("sync-state store", () => {
  it("returns undefined before any state is set", () => {
    const db = openDatabase(":memory:");
    seed(db);
    expect(getSyncState(db, "R_1")).toBeUndefined();
  });

  it("creates state with defaults and updates a subset of fields", () => {
    const db = openDatabase(":memory:");
    seed(db);
    setSyncState(db, "R_1", { status: "syncing" });
    expect(getSyncState(db, "R_1")).toEqual({
      repoId: "R_1",
      lastSyncedAt: null,
      status: "syncing",
      error: null,
    });
    setSyncState(db, "R_1", { status: "idle", lastSyncedAt: "2026-01-02T00:00:00Z" });
    expect(getSyncState(db, "R_1")).toEqual({
      repoId: "R_1",
      lastSyncedAt: "2026-01-02T00:00:00Z",
      status: "idle",
      error: null,
    });
  });

  it("records an error", () => {
    const db = openDatabase(":memory:");
    seed(db);
    setSyncState(db, "R_1", { status: "error", error: "boom" });
    expect(getSyncState(db, "R_1")?.error).toBe("boom");
    expect(listSyncStates(db)).toHaveLength(1);
  });
});
