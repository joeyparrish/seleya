import path from "node:path";
import express from "express";
import type Database from "better-sqlite3";
import type { Config } from "../config/schema.js";
import { listTabMemberships } from "../db/membership.js";
import { assembleTab } from "../query/assemble.js";
import type { RefreshController } from "../refresh/orchestrator.js";

export interface AppDeps {
  db: Database.Database;
  config: Config;
  refresh: RefreshController;
  /** Absolute path to the built client to serve statically (optional). */
  clientDir?: string;
  /** Injectable clock for tests. */
  now?: () => Date;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.use(express.json());
  const now = deps.now ?? (() => new Date());

  app.get("/api/tabs", (_req, res) => {
    const memberships = listTabMemberships(deps.db);
    // Opening the dashboard kicks a background refresh when data is stale or no
    // membership has been persisted yet (e.g. the DB was populated by the CLI,
    // which does not persist membership). The response is served immediately
    // from the local store regardless.
    if (
      !deps.refresh.getStatus().running &&
      (memberships.length === 0 || deps.refresh.isStaleOverall(now()))
    ) {
      void deps.refresh.refresh();
    }
    const tabs = memberships.map((m) => ({ index: m.position, name: m.tabName }));
    res.json({ tabs });
  });

  app.get("/api/tabs/:index", (req, res) => {
    const index = Number(req.params.index);
    const membership = listTabMemberships(deps.db).find((m) => m.position === index);
    const tab = deps.config.tabs[index];
    if (!membership || !tab) {
      res.status(404).json({ error: "tab not found" });
      return;
    }
    res.json(assembleTab(deps.db, membership, tab, now()));
  });

  app.get("/api/refresh/status", (_req, res) => {
    res.json(deps.refresh.getStatus());
  });

  app.post("/api/refresh", (req, res) => {
    const deep = req.query.deep === "true";
    void deps.refresh.refresh({ deep });
    res.status(202).json(deps.refresh.getStatus());
  });

  if (deps.clientDir) {
    const clientDir = deps.clientDir;
    app.use(express.static(clientDir));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api/")) {
        next();
        return;
      }
      res.sendFile(path.join(clientDir, "index.html"));
    });
  }

  return app;
}
