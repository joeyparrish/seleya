import type Database from "better-sqlite3";

export interface RepoRow {
  id: string;
  owner: string;
  name: string;
  isFork: boolean;
}

interface RawRepo {
  id: string;
  owner: string;
  name: string;
  is_fork: number;
}

function toRow(r: RawRepo): RepoRow {
  return { id: r.id, owner: r.owner, name: r.name, isFork: r.is_fork === 1 };
}

export function upsertRepo(db: Database.Database, repo: RepoRow): void {
  db.prepare(
    `INSERT INTO repos (id, owner, name, is_fork)
     VALUES (@id, @owner, @name, @is_fork)
     ON CONFLICT(id) DO UPDATE SET owner=@owner, name=@name, is_fork=@is_fork`,
  ).run({ id: repo.id, owner: repo.owner, name: repo.name, is_fork: repo.isFork ? 1 : 0 });
}

export function getRepo(
  db: Database.Database,
  owner: string,
  name: string,
): RepoRow | undefined {
  const row = db
    .prepare("SELECT id, owner, name, is_fork FROM repos WHERE owner=? AND name=?")
    .get(owner, name) as RawRepo | undefined;
  return row ? toRow(row) : undefined;
}

export function listRepos(db: Database.Database): RepoRow[] {
  const rows = db
    .prepare("SELECT id, owner, name, is_fork FROM repos ORDER BY owner, name")
    .all() as RawRepo[];
  return rows.map(toRow);
}
