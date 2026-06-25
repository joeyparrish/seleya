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

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isLoopbackBind(addr: string): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "localhost";
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();

  // When bound to loopback (the default), reject requests whose Host header is
  // not a loopback name (or an operator-configured allowedHosts entry). This
  // blocks DNS-rebinding attacks, where a site the operator visits rebinds its
  // hostname to 127.0.0.1 to read private data as same-origin. To expose Seleya
  // through a reverse proxy or port-forward while still binding loopback, add the
  // public hostname to `allowedHosts`. Non-loopback binds (intentional public
  // deployments) skip this entirely.
  if (isLoopbackBind(deps.config.bindAddress)) {
    const allowed = new Set([
      ...LOOPBACK_HOSTS,
      ...deps.config.allowedHosts.map((h) => h.toLowerCase()),
    ]);
    app.use((req, res, next) => {
      const hostname = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
      if (allowed.has(hostname)) {
        next();
      } else {
        res.status(403).type("text/plain").send("Forbidden: unexpected Host header");
      }
    });
  }

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
    // A manual refresh always forces a re-sync, regardless of TTL.
    void deps.refresh.refresh({ deep, force: true });
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
