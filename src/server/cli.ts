import { loadConfig } from "./config/load.js";
import { openDatabase } from "./db/database.js";
import { upsertRepo } from "./db/repos.js";
import { getSyncState } from "./db/syncState.js";
import { createGitHubClient, createDefaultRequest } from "./github/client.js";
import { resolveRepos } from "./resolver/repoResolver.js";
import { syncStaleRepos } from "./sync/engine.js";

async function main(): Promise<void> {
  const { config, token } = loadConfig();
  const db = openDatabase(process.env.SELEYA_DB ?? "seleya.db");
  const client = createGitHubClient(createDefaultRequest(token));

  const { allRepos } = await resolveRepos(config, client);
  for (const r of allRepos) upsertRepo(db, r);

  console.log(`Resolved ${allRepos.length} repositories. Syncing...`);
  await syncStaleRepos(db, client, allRepos, config.ttlMinutes, { force: true });

  for (const r of allRepos) {
    const s = getSyncState(db, r.id);
    console.log(`${r.owner}/${r.name}: ${s?.status}${s?.error ? ` (${s.error})` : ""}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
