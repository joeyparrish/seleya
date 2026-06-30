import type Database from "better-sqlite3";
import type { Config } from "../config/schema.js";
import type { GitHubClient } from "../github/client.js";
import type { RepoInfo } from "../github/types.js";
import { upsertRepo, deleteRepo, listRepos } from "../db/repos.js";
import { getSyncState } from "../db/syncState.js";
import { replaceTabMemberships } from "../db/membership.js";
import { resolveRepos } from "../resolver/repoResolver.js";
import { isStale, syncStaleRepos } from "../sync/engine.js";
import { reconcileRepoIssues } from "./reconcile.js";

// "sync" is the per-repo incremental fetch; "reconcile" is the deep-refresh
// second pass over every repo. Each phase counts completed/total independently.
export type RefreshPhase = "sync" | "reconcile";

export interface RefreshStatus {
  running: boolean;
  deep: boolean;
  phase: RefreshPhase | null;
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
    phase: null,
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

  async refresh(opts?: { deep?: boolean; force?: boolean; now?: Date }): Promise<void> {
    if (this.status.running) return;
    const deep = opts?.deep ?? false;
    // A manual refresh forces a re-sync of every repo regardless of TTL; a deep
    // refresh always forces. The automatic on-open trigger leaves force off so it
    // only syncs repos past their TTL.
    const force = (opts?.force ?? false) || deep;
    const now = opts?.now ?? new Date();
    this.status = {
      ...idleStatus(),
      running: true,
      deep,
      phase: "sync",
      startedAt: now.toISOString(),
    };

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
        force,
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

      if (deep) await this.reconcileAll(allRepos);
    } catch (err) {
      this.status.lastError = err instanceof Error ? err.message : String(err);
    } finally {
      this.status.running = false;
      this.status.phase = null;
      this.status.finishedAt = new Date().toISOString();
    }
  }

  /**
   * Deep-refresh second pass: reconcile every repo against its full upstream open
   * set. Runs with the same bounded concurrency as the sync phase, isolates
   * per-repo errors so one failure does not sink the batch, and drives the same
   * completed/total/currentRepos counters (reset for this phase) so the progress
   * indicator keeps moving past the sync phase rather than freezing at N/N.
   */
  private async reconcileAll(repos: RepoInfo[]): Promise<void> {
    this.status.phase = "reconcile";
    this.status.completed = 0;
    this.status.total = repos.length;
    this.status.currentRepos = [];

    const workerCount = Math.max(1, Math.min(this.config.syncConcurrency, repos.length));
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < repos.length) {
        const repo = repos[next++];
        if (!repo) break;
        const label = `${repo.owner}/${repo.name}`;
        this.status.currentRepos.push(label);
        try {
          await reconcileRepoIssues(this.db, this.client, repo);
        } catch (err) {
          this.status.errors++;
          this.status.lastError = err instanceof Error ? err.message : String(err);
        } finally {
          this.status.currentRepos = this.status.currentRepos.filter((x) => x !== label);
          this.status.completed++;
        }
      }
    };
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  }
}
