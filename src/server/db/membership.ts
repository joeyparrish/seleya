import type Database from "better-sqlite3";

export interface TabMembership {
  position: number;
  tabName: string;
  repoIds: string[];
}

/**
 * Replaces the persisted tab->repo mapping in one transaction. `position` is the
 * tab's index in the config (stable even when an empty catch-all tab is omitted),
 * letting the read path recover each tab's group definitions from the config.
 */
export function replaceTabMemberships(
  db: Database.Database,
  tabs: Array<{ position: number; name: string; repoIds: string[] }>,
): void {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM tab_repos").run();
    const ins = db.prepare("INSERT INTO tab_repos (position, tab_name, repo_id) VALUES (?, ?, ?)");
    for (const t of tabs) {
      for (const id of t.repoIds) ins.run(t.position, t.name, id);
    }
  });
  tx();
}

/**
 * Repo ids grouped by tab name. The read path matches the live config's tabs to
 * their persisted repos by name, so reordering or renaming tabs in the config
 * does not require a refresh to take effect.
 */
export function tabRepoIdsByName(db: Database.Database): Map<string, string[]> {
  const rows = db
    .prepare("SELECT tab_name, repo_id FROM tab_repos ORDER BY rowid")
    .all() as Array<{ tab_name: string; repo_id: string }>;
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const arr = map.get(r.tab_name) ?? [];
    arr.push(r.repo_id);
    map.set(r.tab_name, arr);
  }
  return map;
}

export function listTabMemberships(db: Database.Database): TabMembership[] {
  const rows = db
    .prepare("SELECT position, tab_name, repo_id FROM tab_repos ORDER BY position")
    .all() as Array<{ position: number; tab_name: string; repo_id: string }>;

  const byPosition = new Map<number, TabMembership>();
  for (const r of rows) {
    let m = byPosition.get(r.position);
    if (!m) {
      m = { position: r.position, tabName: r.tab_name, repoIds: [] };
      byPosition.set(r.position, m);
    }
    m.repoIds.push(r.repo_id);
  }
  return [...byPosition.values()].sort((a, b) => a.position - b.position);
}
