import path from "node:path";
import express from "express";
import type Database from "better-sqlite3";
import type { Config } from "../config/schema.js";
import { tabRepoIdsByName } from "../db/membership.js";
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
    const byName = tabRepoIdsByName(deps.db);
    // Opening the dashboard kicks a background refresh when data is stale or no
    // membership has been persisted yet (e.g. the DB was populated by the CLI,
    // which does not persist membership). The response is served immediately
    // from the local store regardless.
    if (
      !deps.refresh.getStatus().running &&
      (byName.size === 0 || deps.refresh.isStaleOverall(now()))
    ) {
      void deps.refresh.refresh();
    }
    // Order and names come from the live config; the DB supplies repo membership
    // by name. Tabs with no resolved repos (including an empty catch-all) are
    // hidden.
    const tabs = deps.config.tabs
      .map((tab, index) => ({ index, name: tab.name }))
      .filter(({ name }) => (byName.get(name)?.length ?? 0) > 0);
    res.json({ tabs });
  });

  app.get("/api/tabs/:index", (req, res) => {
    const index = Number(req.params.index);
    const tab = deps.config.tabs[index];
    if (!tab) {
      res.status(404).json({ error: "tab not found" });
      return;
    }
    const repoIds = tabRepoIdsByName(deps.db).get(tab.name) ?? [];
    res.json(
      assembleTab(
        deps.db,
        { position: index, tabName: tab.name, repoIds },
        tab,
        now(),
        deps.config.caseSensitive,
      ),
    );
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
    // sendFile requires an absolute path, so resolve against cwd.
    const clientDir = path.resolve(deps.clientDir);
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
