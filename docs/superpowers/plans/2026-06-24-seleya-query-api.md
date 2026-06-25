# Seleya Query Engine & API Implementation Plan (Plan 2 of 3)

> **For agentic workers:** This plan is executed directly by the controller (the subagent review loop was retired for this project). Each task ends with `tsc --noEmit` + `vitest run` green and a commit. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the local SQLite store (built in Plan 1) into a queryable JSON API: compile config filters into SQL, assemble tabs into groups of issues, orchestrate on-demand refresh (including a deep refresh that reconciles deletions and newly-archived repos), and serve it all over Express.

**Architecture:** A filter compiler translates each group's structured `GroupFilter` into a parameterized SQL `WHERE` clause over the `issues` table and its satellite tables. Tab membership (which repos belong to which tab) is persisted to the DB during refresh so the read path never calls GitHub. A refresh orchestrator (single-flight) resolves repos, persists membership, upserts repos, reconciles repos that dropped out of the match set, and runs the Plan 1 sync engine, tracking status. Express exposes tabs/groups/issues, refresh status, and a refresh trigger, and serves the (Plan 3) static client.

**Tech Stack:** Adds `express` and `supertest` (dev) to the Plan 1 stack. No new runtime concepts beyond Plan 1.

This is Plan 2 of 3. Plan 3 (React 19 + Mantine 9 + TanStack UI, plus README/AGENTS/NOTICE) builds on the API this plan ships. The design spec is `docs/superpowers/specs/2026-06-24-seleya-issue-dashboard-design.md`; read it first.

## Global Constraints

- **No built-in authentication.** The server binds `config.bindAddress` (default `127.0.0.1`). Do not add auth; do not bind `0.0.0.0` by default.
- **The read path (serving tabs/issues) must never call the GitHub API.** It reads only from SQLite. GitHub is touched only by the refresh orchestrator.
- **Only open issues/PRs are retained** (Plan 1 invariant); the query engine never needs to filter by closed state.
- **Cross-org field matching is by field name** (Plan 1 EAV model): filters reference fields/options by name.
- **TypeScript strict, ESM, Node >= 20.** Commits use separate `git add <paths>` + `git commit` (never `git add -A`), ending with the trailer `Co-Authored-By: Claude Code (Claude Opus 4.8) <noreply@anthropic.com>`.
- **Refresh is single-flight:** at most one refresh (normal or deep) runs at a time; a request while one runs is a no-op that returns the current status.

---

### Task 1: Filter → SQL compiler

**Files:**
- Create: `src/server/query/filter.ts`
- Test: `src/server/query/filter.test.ts`

**Interface (`filter.ts`):**
- `interface CompiledFilter { where: string; params: unknown[] }`
- `compileFilter(filter: GroupFilter | undefined, repoIds: string[], now: Date): CompiledFilter`
  - Always scopes to `issues.repo_id IN (<placeholders>)`. If `repoIds` is empty, `where` is `"0"` (matches nothing) with no params.
  - Each present dimension contributes an `AND`-ed condition:
    - `type`: `issues.is_pull_request = 0` (issue) or `= 1` (pull_request).
    - `labelsInclude`: for each label, `EXISTS (SELECT 1 FROM issue_labels l WHERE l.issue_id = issues.id AND l.label = ?)`.
    - `labelsExclude`: for each label, `NOT EXISTS (... l.label = ?)`.
    - `assignee`: `EXISTS (SELECT 1 FROM json_each(issues.assignees) WHERE value = ?)`.
    - `author`: `issues.author = ?`.
    - `milestone`: `issues.milestone = ?`.
    - `issueType`: `issues.issue_type_name IN (<placeholders>)`.
    - `ageDays { op, value }`: compares issue age against `value` days. Age increases as `created_at` decreases, so translate to a `created_at` cutoff: cutoff = `now - value days` (ISO). `>` →  `issues.created_at < ?`; `>=` → `<= ?`; `<` → `> ?`; `<=` → `>= ?` (param = cutoff ISO).
    - `fields[]`: for each `FieldFilter` (matched by `field_name`):
      - `in`: `EXISTS (SELECT 1 FROM issue_field_values v WHERE v.issue_id = issues.id AND v.field_name = ? AND v.value_text IN (<placeholders>))`.
      - `op`/`value` (numeric): `EXISTS (... AND v.field_name = ? AND v.value_number <op> ?)` where `<op>` is one of `> >= < <= = !=` (whitelist-mapped; reject anything else).
      - `unset: true`: `NOT EXISTS (SELECT 1 FROM issue_field_values v WHERE v.issue_id = issues.id AND v.field_name = ?)`.
      - A single `FieldFilter` may combine `in`/numeric and is `AND`-ed; if multiple keys are present, emit each as its own condition.
  - `where` is the conjunction joined by `" AND "`. Params are pushed in clause order.

**Tests (seed an in-memory DB via Plan 1 stores, run `SELECT id FROM issues WHERE <where>` with params, assert id sets):**
- [ ] scopes to repo ids (issue in another repo excluded)
- [ ] empty repoIds matches nothing
- [ ] `type: pull_request` excludes issues
- [ ] `labelsInclude` requires all listed labels; `labelsExclude` removes any with a listed label
- [ ] `assignee` matches via the JSON assignees array
- [ ] `issueType` filters by type name
- [ ] `ageDays { op: '>=', value: 7 }` selects issues older than 7 days and excludes newer ones (seed two issues with `created_at` straddling `now - 7d`)
- [ ] field `in` selects matching single-select value; excludes non-matching and unset
- [ ] field numeric `op`/`value` compares `value_number`
- [ ] field `unset: true` selects issues lacking that field

- [ ] **Step 1:** Write `filter.test.ts` with the cases above (seed via `upsertRepo`/`upsertIssue`/`setIssueFieldValues`).
- [ ] **Step 2:** Run it; confirm it fails (no `filter.ts`).
- [ ] **Step 3:** Implement `compileFilter` per the interface.
- [ ] **Step 4:** Run the tests; confirm green.
- [ ] **Step 5:** Commit (`Add filter-to-SQL compiler`).

---

### Task 2: Tab membership persistence

**Files:**
- Modify: `src/server/db/schema.ts` (add `tab_repos` table)
- Create: `src/server/db/membership.ts`
- Test: `src/server/db/membership.test.ts`

**Schema addition:**
```sql
CREATE TABLE IF NOT EXISTS tab_repos (
  position INTEGER NOT NULL,   -- tab order from config
  tab_name TEXT NOT NULL,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  PRIMARY KEY (tab_name, repo_id)
);
CREATE INDEX IF NOT EXISTS idx_tab_repos_pos ON tab_repos(position);
```

**Interface (`membership.ts`):**
- `interface TabMembership { position: number; tabName: string; repoIds: string[] }`
- `replaceTabMemberships(db, tabs: Array<{ name: string; repoIds: string[] }>): void` — in one transaction, deletes all `tab_repos` rows and inserts the new mapping with `position` = array index.
- `listTabMemberships(db): TabMembership[]` — grouped by tab, ordered by `position`.

**Tests:**
- [ ] round-trips memberships preserving order
- [ ] `replaceTabMemberships` fully replaces prior rows (no stale tabs/repos)

- [ ] **Step 1:** Add the schema, write the failing test.
- [ ] **Step 2:** Implement `membership.ts`.
- [ ] **Step 3:** Green; commit (`Add tab membership persistence`).

---

### Task 3: Tab assembly

**Files:**
- Create: `src/server/query/assemble.ts`
- Test: `src/server/query/assemble.test.ts`

**Interface (`assemble.ts`):**
- `interface IssueView` — the display shape: `id, repo (owner/name), number, title, isPullRequest, state, author, assignees, labels, milestone, createdAt, updatedAt, comments, issueTypeName, url, fields: Array<{ name; dataType; value; optionColor? }>`. (`url` = `https://github.com/<owner>/<name>/issues/<number>` for issues, `/pull/<number>` for PRs.)
- `interface GroupView { name: string; issues: IssueView[] }`
- `interface TabView { name: string; groups: GroupView[] }`
- `assembleTab(db, membership: TabMembership, tab: Tab, now: Date): TabView`
  - If `tab.groups` is empty/undefined, produce a single implicit group `{ name: "All open issues and PRs" }` scoped to the tab's repos (no filter beyond repo scope).
  - Otherwise one `GroupView` per configured group, using `compileFilter(group.filter, membership.repoIds, now)`.
  - Issues are fetched by joining `issues` → `repos`, ordered by `updated_at DESC`, then hydrated with labels, assignees (parsed JSON), and field values (joined to `field_options` for `optionColor`).
- `assembleAllTabs(db, config: Config, now: Date): TabView[]` — reads `listTabMemberships`, pairs each with its `config.tabs[position]`, calls `assembleTab`. Tabs with no membership row (e.g. an omitted empty catch-all) are skipped.

**Tests (seed repos, issues, field values, and memberships):**
- [ ] a tab with no groups yields one implicit group containing all its repos' issues
- [ ] a tab with two groups partitions issues per filter
- [ ] `IssueView.url` is the issues path for issues and the pull path for PRs
- [ ] field values are attached with option colors where available
- [ ] issues are ordered by `updated_at` descending

- [ ] **Step 1-5:** TDD as above; commit (`Add tab assembly`).

---

### Task 4: Refresh orchestrator

**Files:**
- Create: `src/server/refresh/orchestrator.ts`
- Test: `src/server/refresh/orchestrator.test.ts`

**Interface (`orchestrator.ts`):**
- `interface RefreshStatus { running: boolean; deep: boolean; startedAt: string | null; finishedAt: string | null; total: number; completed: number; errors: number; currentRepos: string[]; lastError: string | null }`
- `class RefreshController`
  - `constructor(db, client: GitHubClient, config: Config)`
  - `getStatus(): RefreshStatus`
  - `isStaleOverall(now: Date): boolean` — true if any persisted repo is stale by its tab's TTL (or there is no membership yet).
  - `refresh(opts?: { deep?: boolean; now?: Date }): Promise<void>` — single-flight (if `running`, returns immediately). Steps:
    1. mark `running`, reset counters.
    2. `resolveRepos(config, client)` → resolved tabs.
    3. `upsertRepo` each resolved repo; `replaceTabMemberships` from resolved tabs.
    4. **Reconcile dropped repos:** delete from `repos` every repo not in the resolved set (cascades to issues/labels/field values/sync_state). This removes newly-archived/transferred repos and their issues.
    5. run `syncStaleRepos(db, client, allResolvedRepos, ttlMinutes, { force: deep, concurrency: config.syncConcurrency, rediscover: deep, onRepoStart, onRepoDone })`, updating `currentRepos`/`completed`/`errors` via the callbacks. (Per-tab TTL override: compute the minimum applicable TTL per repo; for v1 use the global `config.ttlMinutes` for staleness and rely on `force` for deep — per-tab TTL refinement is noted but the global TTL is acceptable here.)
    6. if `deep`, additionally run per-repo deletion reconciliation (Task 5's `reconcileRepoIssues`).
    7. mark `finishedAt`, `running = false`. On a thrown error, record `lastError` and still clear `running`.

**Tests (with a fake `GitHubClient`):**
- [ ] a refresh resolves, persists memberships, upserts repos, and syncs
- [ ] a repo present in the DB but absent from the new resolved set is deleted (issues gone)
- [ ] single-flight: calling `refresh` while one is running is a no-op (second call does not double-sync)
- [ ] status counters reflect completed/errors

- [ ] **Step 1-5:** TDD; commit (`Add refresh orchestrator`).

---

### Task 5: Deep refresh reconciliation

**Files:**
- Create: `src/server/refresh/reconcile.ts`
- Test: `src/server/refresh/reconcile.test.ts`

**Interface (`reconcile.ts`):**
- `async reconcileRepoIssues(db, client: GitHubClient, repo: RepoInfo): Promise<void>` — fetches the **full** current open-issue + open-PR id set for the repo (via `client.fetchIssuesUpdatedSince(owner, name, null)`), then deletes any local issue row for that repo whose id is not in the fetched-open set. This catches issues deleted/transferred on GitHub (which incremental `updatedAt` deltas miss). Open issues returned are also upserted (so the deep refresh doubles as a full resync).
- This is invoked by the orchestrator's deep path (Task 4 step 6) for each resolved repo.

Note: the orchestrator's step 4 already handles whole-repo disappearance (archived/dropped). `reconcileRepoIssues` handles individual issue disappearance within a still-active repo.

**Tests:**
- [ ] an open issue removed on GitHub (absent from the full fetch) is deleted locally
- [ ] issues still open remain; newly returned open issues are inserted

- [ ] **Step 1-5:** TDD; commit (`Add deep-refresh issue reconciliation`).

---

### Task 6: Express API and server entry

**Files:**
- Create: `src/server/api/routes.ts`
- Create: `src/server/server.ts`
- Test: `src/server/api/routes.test.ts`
- Modify: `package.json` (add `express`; add `supertest` to devDeps; add `start`/`dev` scripts), `config.example.yaml` (no change needed unless noting endpoints)

**Interface (`routes.ts`):**
- `createApp(deps: { db; config: Config; refresh: RefreshController; clientDir?: string }): express.Express`
  - `GET /api/tabs` → `{ tabs: Array<{ index: number; name: string }> }` from `listTabMemberships`. Side effect: if `refresh.isStaleOverall(now)` and not already running, kick `refresh.refresh()` in the background (do not await).
  - `GET /api/tabs/:index` → the `TabView` for that tab (`assembleTab` for the membership at that position). 404 if out of range.
  - `GET /api/refresh/status` → `refresh.getStatus()`.
  - `POST /api/refresh` (optional `?deep=true`) → kicks `refresh.refresh({ deep })` in the background (no-op if running), returns `202` with the current status.
  - If `clientDir` is provided, serve it statically and SPA-fallback `GET *` (non-`/api`) to `index.html`. (In Plan 2 there is no client yet; `clientDir` is optional so the API is testable standalone.)
- `server.ts`: load config, open DB (`SELEYA_DB` or `seleya.db`), build client + `RefreshController`, `createApp`, `listen(config.port, config.bindAddress)`. Log the bound URL and the no-auth warning.

**Tests (`supertest` against `createApp` with a fake `RefreshController` and a seeded in-memory DB):**
- [ ] `GET /api/tabs` returns persisted tab names/indices
- [ ] `GET /api/tabs/:index` returns assembled groups/issues; 404 for a bad index
- [ ] `GET /api/refresh/status` returns the controller status
- [ ] `POST /api/refresh` triggers refresh (spy on the controller) and returns 202
- [ ] `GET /api/tabs` triggers a background refresh when stale (spy), and does not when fresh/running

- [ ] **Step 1:** Add `express`/`supertest` to `package.json`; `npm install`.
- [ ] **Step 2:** Write `routes.test.ts` (failing).
- [ ] **Step 3:** Implement `routes.ts` and `server.ts`.
- [ ] **Step 4:** Green; `npm run typecheck` + `npm test` clean.
- [ ] **Step 5:** Commit (`Add Express API and server entry`).

---

## Manual verification (end of Plan 2)

With a real `config.yaml` + token and a populated `seleya.db`:
1. `npm run start` (or `tsx src/server/server.ts`).
2. `curl localhost:<port>/api/tabs` → tab list.
3. `curl localhost:<port>/api/tabs/0` → groups with issues, including any `fields`.
4. `curl -X POST 'localhost:<port>/api/refresh?deep=true'` then poll `curl localhost:<port>/api/refresh/status` until `running:false`.
5. Confirm a repo you archive on GitHub disappears from the data after a deep refresh.

## Coverage against the spec (self-review)

- Structured filters → local SQL (labels in/out, type, assignee, author, milestone, age, issue Type, custom fields by name incl. `unset`): Task 1.
- Implicit "all open issues and PRs" group when a tab has no groups: Task 3.
- Read path never calls GitHub (persisted membership): Tasks 2-3, 6.
- On-open refresh-if-stale, manual refresh now, refresh status for the UI indicator: Tasks 4, 6.
- Deep refresh reconciles deletions/transfers and newly-archived repos: Tasks 4-5.
- Bind localhost, no auth: Task 6 + Global Constraints.
- Deferred to Plan 3: the React/Mantine UI (tabs, collapsible group sections, sortable tables, refresh indicator + "reload when ready" + "refresh now"), option-color rendering in the UI, and README/AGENTS/NOTICE. Per-tab TTL staleness refinement (Plan 2 uses the global TTL for staleness) is also a candidate refinement.
