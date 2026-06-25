import type Database from "better-sqlite3";

export type SyncStatus = "idle" | "syncing" | "error";

export interface SyncStateRow {
  repoId: string;
  lastSyncedAt: string | null;
  status: SyncStatus;
  error: string | null;
}

interface RawSyncState {
  repo_id: string;
  last_synced_at: string | null;
  status: SyncStatus;
  error: string | null;
}

function toRow(r: RawSyncState): SyncStateRow {
  return {
    repoId: r.repo_id,
    lastSyncedAt: r.last_synced_at,
    status: r.status,
    error: r.error,
  };
}

export function getSyncState(
  db: Database.Database,
  repoId: string,
): SyncStateRow | undefined {
  const row = db.prepare("SELECT * FROM sync_state WHERE repo_id=?").get(repoId) as
    | RawSyncState
    | undefined;
  return row ? toRow(row) : undefined;
}

export function setSyncState(
  db: Database.Database,
  repoId: string,
  patch: Partial<Omit<SyncStateRow, "repoId">>,
): void {
  const existing = getSyncState(db, repoId);
  const next: SyncStateRow = {
    repoId,
    lastSyncedAt: patch.lastSyncedAt ?? existing?.lastSyncedAt ?? null,
    status: patch.status ?? existing?.status ?? "idle",
    error: patch.error !== undefined ? patch.error : (existing?.error ?? null),
  };
  db.prepare(
    `INSERT INTO sync_state (repo_id, last_synced_at, status, error)
     VALUES (@repo_id, @last_synced_at, @status, @error)
     ON CONFLICT(repo_id) DO UPDATE SET
       last_synced_at=@last_synced_at, status=@status, error=@error`,
  ).run({
    repo_id: next.repoId,
    last_synced_at: next.lastSyncedAt,
    status: next.status,
    error: next.error,
  });
}

export function listSyncStates(db: Database.Database): SyncStateRow[] {
  const rows = db.prepare("SELECT * FROM sync_state").all() as RawSyncState[];
  return rows.map(toRow);
}
