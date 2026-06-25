import { loadConfig } from "./config/load.js";
import { openDatabase } from "./db/database.js";
import { upsertRepo } from "./db/repos.js";
import { listIssueIdsByRepo } from "./db/issues.js";
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
  let done = 0;
  let errors = 0;
  await syncStaleRepos(db, client, allRepos, config.ttlMinutes, {
    force: true,
    concurrency: config.syncConcurrency,
    onRepoStart: (r) => console.log(`  [start] ${r.owner}/${r.name}`),
    onRepoDone: (r, s) => {
      done++;
      const prefix = `  [${done}/${allRepos.length}]`;
      if (s?.status === "error") {
        errors++;
        console.log(`${prefix} ERROR ${r.owner}/${r.name}: ${s.error}`);
      } else {
        const count = listIssueIdsByRepo(db, r.id).length;
        console.log(`${prefix} ${r.owner}/${r.name} (${count} open items)`);
      }
    },
  });
  console.log(`Done: ${allRepos.length - errors}/${allRepos.length} repos synced, ${errors} error(s).`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
