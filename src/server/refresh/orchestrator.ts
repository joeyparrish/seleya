import type Database from "better-sqlite3";
import type { Config } from "../config/schema.js";
import type { GitHubClient } from "../github/client.js";
import { upsertRepo, deleteRepo, listRepos } from "../db/repos.js";
import { getSyncState } from "../db/syncState.js";
import { replaceTabMemberships } from "../db/membership.js";
import { resolveRepos } from "../resolver/repoResolver.js";
import { isStale, syncStaleRepos } from "../sync/engine.js";
import { reconcileRepoIssues } from "./reconcile.js";

export interface RefreshStatus {
  running: boolean;
  deep: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  total: number;
  completed: number;
  errors: number;
  currentRepos: string[];
  lastError: string | null;
}

function idleStatus(): RefreshStatus {
  return {
    running: false,
    deep: false,
    startedAt: null,
    finishedAt: null,
    total: 0,
    completed: 0,
    errors: 0,
    currentRepos: [],
    lastError: null,
  };
}

/**
 * Orchestrates a refresh: resolve repos from GitHub, persist tab membership,
 * upsert repos, drop repos that left the match set (archived/transferred), and
 * run the sync engine. A deep refresh additionally forces rediscovery and a
 * full per-repo issue reconciliation. At most one refresh runs at a time.
 */
export class RefreshController {
  private status: RefreshStatus = idleStatus();

  constructor(
    private readonly db: Database.Database,
    private readonly client: GitHubClient,
    private readonly config: Config,
  ) {}

  getStatus(): RefreshStatus {
    return { ...this.status, currentRepos: [...this.status.currentRepos] };
  }

  isStaleOverall(now: Date): boolean {
    const repos = listRepos(this.db);
    if (repos.length === 0) return true;
    return repos.some((r) => isStale(getSyncState(this.db, r.id), this.config.ttlMinutes, now));
  }

  async refresh(opts?: { deep?: boolean; now?: Date }): Promise<void> {
    if (this.status.running) return;
    const deep = opts?.deep ?? false;
    const now = opts?.now ?? new Date();
    this.status = { ...idleStatus(), running: true, deep, startedAt: now.toISOString() };

    try {
      const { tabs, allRepos } = await resolveRepos(this.config, this.client);

      for (const r of allRepos) upsertRepo(this.db, r);
      replaceTabMemberships(
        this.db,
        tabs.map((rt) => ({
          position: this.config.tabs.indexOf(rt.tab),
          name: rt.name,
          repoIds: rt.repos.map((r) => r.id),
        })),
      );

      // Drop repos that are no longer in the match set (archived/transferred);
      // the cascade removes their issues, labels, field values, and sync state.
      const keep = new Set(allRepos.map((r) => r.id));
      for (const existing of listRepos(this.db)) {
        if (!keep.has(existing.id)) deleteRepo(this.db, existing.id);
      }

      this.status.total = allRepos.length;
      await syncStaleRepos(this.db, this.client, allRepos, this.config.ttlMinutes, {
        force: deep,
        rediscover: deep,
        concurrency: this.config.syncConcurrency,
        now,
        onRepoStart: (r) => {
          this.status.currentRepos.push(`${r.owner}/${r.name}`);
        },
        onRepoDone: (r, s) => {
          this.status.currentRepos = this.status.currentRepos.filter(
            (x) => x !== `${r.owner}/${r.name}`,
          );
          this.status.completed++;
          if (s?.status === "error") this.status.errors++;
        },
      });

      if (deep) {
        for (const r of allRepos) await reconcileRepoIssues(this.db, this.client, r);
      }
    } catch (err) {
      this.status.lastError = err instanceof Error ? err.message : String(err);
    } finally {
      this.status.running = false;
      this.status.finishedAt = new Date().toISOString();
    }
  }
}
