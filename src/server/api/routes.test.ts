import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/database.js";
import { upsertRepo } from "../db/repos.js";
import { upsertIssue, type IssueRecord } from "../db/issues.js";
import { replaceTabMemberships } from "../db/membership.js";
import { createApp } from "./routes.js";
import type { Config } from "../config/schema.js";
import type { RefreshController, RefreshStatus } from "../refresh/orchestrator.js";

const config: Config = {
  username: "o",
  ttlMinutes: 10,
  syncConcurrency: 6,
  caseSensitive: false,
  bindAddress: "127.0.0.1",
  port: 8080,
  allowedHosts: [],
  forkAllowlist: [],
  tabs: [{ name: "Org", match: [{ org: "o" }] }],
};

function makeRefresh(opts: { running?: boolean; stale?: boolean } = {}) {
  const refresh = vi.fn(async () => {});
  const status: RefreshStatus = {
    running: opts.running ?? false,
    deep: false,
    phase: null,
    startedAt: null,
    finishedAt: null,
    total: 1,
    completed: 1,
    errors: 0,
    currentRepos: [],
    lastError: null,
  };
  const controller = {
    refresh,
    getStatus: () => status,
    isStaleOverall: () => opts.stale ?? false,
  } as unknown as RefreshController;
  return { controller, refresh, status };
}

function seed(db: Database.Database) {
  upsertRepo(db, { id: "R_1", owner: "o", name: "a", isFork: false });
  const issue: IssueRecord = {
    id: "I_1", repoId: "R_1", number: 1, title: "hello", isPullRequest: false, state: "OPEN",
    author: "me", assignees: [], labels: [], milestone: null,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z",
    comments: 0, issueTypeId: null, issueTypeName: null,
  };
  upsertIssue(db, issue);
  replaceTabMemberships(db, [{ position: 0, name: "Org", repoIds: ["R_1"] }]);
}

describe("API routes", () => {
  it("GET /api/tabs returns persisted tab indices and names", async () => {
    const db = openDatabase(":memory:");
    seed(db);
    const app = createApp({ db, config, refresh: makeRefresh().controller });
    const res = await request(app).get("/api/tabs");
    expect(res.status).toBe(200);
    expect(res.body.tabs).toEqual([{ index: 0, name: "Org" }]);
    // The response carries the current refresh status so the client can pick up
    // an on-open refresh without a separate poll racing the trigger.
    expect(res.body.refreshStatus).toMatchObject({ running: false });
  });

  it("GET /api/tabs returns tabs in config order, matched by name (survives reorder)", async () => {
    const db = openDatabase(":memory:");
    upsertRepo(db, { id: "R_1", owner: "o", name: "a", isFork: false });
    upsertRepo(db, { id: "R_2", owner: "o", name: "b", isFork: false });
    // Persisted earlier as Alpha=0, Beta=1.
    replaceTabMemberships(db, [
      { position: 0, name: "Alpha", repoIds: ["R_1"] },
      { position: 1, name: "Beta", repoIds: ["R_2"] },
    ]);
    // Config now lists Beta before Alpha; no refresh has run.
    const reordered: Config = {
      ...config,
      tabs: [
        { name: "Beta", match: [{ org: "o" }] },
        { name: "Alpha", match: [{ org: "o" }] },
      ],
    };
    const res = await request(
      createApp({ db, config: reordered, refresh: makeRefresh().controller }),
    ).get("/api/tabs");
    expect(res.body.tabs).toEqual([
      { index: 0, name: "Beta" },
      { index: 1, name: "Alpha" },
    ]);
  });

  it("GET /api/tabs/:index assembles the tab; 404 for an unknown index", async () => {
    const db = openDatabase(":memory:");
    seed(db);
    const app = createApp({ db, config, refresh: makeRefresh().controller });

    const ok = await request(app).get("/api/tabs/0");
    expect(ok.status).toBe(200);
    expect(ok.body.name).toBe("Org");
    expect(ok.body.groups[0].issues[0].id).toBe("I_1");

    const missing = await request(app).get("/api/tabs/9");
    expect(missing.status).toBe(404);
  });

  it("GET /api/refresh/status returns the controller status", async () => {
    const db = openDatabase(":memory:");
    seed(db);
    const { controller, status } = makeRefresh();
    const app = createApp({ db, config, refresh: controller });
    const res = await request(app).get("/api/refresh/status");
    expect(res.body).toEqual(status);
  });

  it("POST /api/refresh triggers a refresh and returns 202", async () => {
    const db = openDatabase(":memory:");
    seed(db);
    const { controller, refresh } = makeRefresh();
    const app = createApp({ db, config, refresh: controller });
    const res = await request(app).post("/api/refresh?deep=true");
    expect(res.status).toBe(202);
    expect(refresh).toHaveBeenCalledWith({ deep: true, force: true });
  });

  it("GET /api/tabs background-refreshes only when stale and not already running", async () => {
    const db = openDatabase(":memory:");
    seed(db);

    const stale = makeRefresh({ stale: true });
    await request(createApp({ db, config, refresh: stale.controller })).get("/api/tabs");
    expect(stale.refresh).toHaveBeenCalledTimes(1);

    const fresh = makeRefresh({ stale: false });
    await request(createApp({ db, config, refresh: fresh.controller })).get("/api/tabs");
    expect(fresh.refresh).not.toHaveBeenCalled();

    const running = makeRefresh({ stale: true, running: true });
    await request(createApp({ db, config, refresh: running.controller })).get("/api/tabs");
    expect(running.refresh).not.toHaveBeenCalled();
  });

  it("rejects a non-loopback Host header when bound to loopback (DNS rebinding)", async () => {
    const db = openDatabase(":memory:");
    seed(db);
    const app = createApp({ db, config, refresh: makeRefresh().controller });

    const evil = await request(app).get("/api/tabs").set("Host", "evil.example.com");
    expect(evil.status).toBe(403);

    const ok = await request(app).get("/api/tabs").set("Host", "localhost:7920");
    expect(ok.status).toBe(200);
  });

  it("permits a configured allowedHosts entry while still bound to loopback", async () => {
    const db = openDatabase(":memory:");
    seed(db);
    const proxied: Config = { ...config, allowedHosts: ["dashboard.example.com"] };
    const app = createApp({ db, config: proxied, refresh: makeRefresh().controller });

    const ok = await request(app).get("/api/tabs").set("Host", "dashboard.example.com");
    expect(ok.status).toBe(200);
    const evil = await request(app).get("/api/tabs").set("Host", "evil.example.com");
    expect(evil.status).toBe(403);
  });

  it("does not enforce the Host header when bound to a non-loopback address", async () => {
    const db = openDatabase(":memory:");
    seed(db);
    const publicConfig: Config = { ...config, bindAddress: "0.0.0.0" };
    const app = createApp({ db, config: publicConfig, refresh: makeRefresh().controller });

    const res = await request(app).get("/api/tabs").set("Host", "dashboard.example.com");
    expect(res.status).toBe(200);
  });

  it("GET /api/tabs background-refreshes when no membership is persisted, even if fresh", async () => {
    const db = openDatabase(":memory:"); // no membership seeded
    const fresh = makeRefresh({ stale: false });
    const res = await request(createApp({ db, config, refresh: fresh.controller })).get("/api/tabs");
    expect(res.body.tabs).toEqual([]);
    expect(fresh.refresh).toHaveBeenCalledTimes(1);
  });
});
