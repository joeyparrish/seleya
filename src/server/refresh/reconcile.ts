import type Database from "better-sqlite3";
import type { GitHubClient } from "../github/client.js";
import type { RepoInfo } from "../github/types.js";
import { deleteIssue, listIssueIdsByRepo } from "../db/issues.js";
import { applyFetchedIssues } from "../sync/engine.js";

/**
 * Deep reconciliation for a single repo: fetches the repo's full current open
 * issue + PR set and deletes any local issue for the repo that is no longer
 * present upstream. This catches issues deleted, closed, or transferred on
 * GitHub, which an incremental `updatedAt` delta cannot observe. Open items in
 * the fetch are also upserted, so a deep refresh doubles as a full resync.
 *
 * The fetch is open-only: the local store holds open issues, so the set of
 * upstream-open ids is all reconciliation needs, and skipping closed history
 * avoids paging through (potentially thousands of) closed items per repo.
 */
export async function reconcileRepoIssues(
  db: Database.Database,
  client: GitHubClient,
  repo: RepoInfo,
): Promise<void> {
  const fetched = await client.fetchOpenIssues(repo.owner, repo.name);
  const openIds = applyFetchedIssues(db, repo.id, fetched);
  for (const localId of listIssueIdsByRepo(db, repo.id)) {
    if (!openIds.has(localId)) deleteIssue(db, localId);
  }
}
