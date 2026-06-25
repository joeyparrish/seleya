import type Database from "better-sqlite3";
import type { GitHubClient } from "../github/client.js";
import type { RepoInfo } from "../github/types.js";
import { deleteIssue, listIssueIdsByRepo } from "../db/issues.js";
import { applyFetchedIssues } from "../sync/engine.js";

/**
 * Deep reconciliation for a single repo: fetches the repo's full current open
 * issue + PR set (since = null) and deletes any local issue for the repo that is
 * no longer present upstream. This catches issues deleted or transferred on
 * GitHub, which an incremental `updatedAt` delta cannot observe. Open items in
 * the full fetch are also upserted, so a deep refresh doubles as a full resync.
 */
export async function reconcileRepoIssues(
  db: Database.Database,
  client: GitHubClient,
  repo: RepoInfo,
): Promise<void> {
  const fetched = await client.fetchIssuesUpdatedSince(repo.owner, repo.name, null);
  const openIds = applyFetchedIssues(db, repo.id, fetched);
  for (const localId of listIssueIdsByRepo(db, repo.id)) {
    if (!openIds.has(localId)) deleteIssue(db, localId);
  }
}
