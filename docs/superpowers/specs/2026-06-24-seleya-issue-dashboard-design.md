# Seleya: Cross-Repository GitHub Issue Dashboard

**Status:** Design approved, pending spec review
**Date:** 2026-06-24

Seleya is a self-hosted, web-based dashboard that aggregates open issues and pull
requests across many GitHub repositories and organizations, organizing them into
configurable tabs and issue groupings. It is named after the tallest mountain on
Vulcan: a high vantage point from which to see far across your projects.

## Purpose and goals

A single person (or small team) often has work scattered across multiple GitHub
orgs and personal repos. Seleya gathers all of it into one local view, grouped
the way the operator thinks about it, with visibility into private repositories
via a Personal Access Token (PAT). It surfaces GitHub's newer beta issue features
(Types and custom Fields such as Priority and Effort) that the normal REST/issues
API and `gh issue` commands do not expose.

Primary design priorities:

- Run locally with access to private repositories.
- Be deployable on a public cloud VM (with access gating handled externally).
- Respect GitHub API rate limits via local caching.
- Open-source under Apache 2.0.

## Security model (hard requirement)

Seleya has **no built-in authentication**. It binds to `127.0.0.1` by default.
Running it against private repositories requires the operator to gate access at
the network or deployment layer (localhost-only, VPN/Tailscale, reverse-proxy
auth, firewall, SSH tunnel). The README and configuration must state this plainly
and prominently. The bind address is configurable for intentional non-local
deployments, but the default and the documentation steer hard toward safe usage.

The PAT is never stored in the committed config file. It is read from an
environment variable (or a separate, gitignored secrets file). The SQLite
database (which contains private issue data) is gitignored.

## Architecture overview

A single TypeScript application with two halves served from one process:

- An **Express backend** (TypeScript) that owns the database, the sync engine,
  and a small HTTP/JSON API, and also serves the built frontend as static assets.
- A **React frontend** (React 19 + Mantine 9 + TanStack Query/Table).

**SQLite (via `better-sqlite3`) is the source of truth.** A sync engine pulls
open issues and PRs from GitHub into SQLite. The UI reads only from SQLite, so it
is instant and works even when GitHub is unreachable. Configuration is a YAML
file; the PAT comes from the environment.

GitHub access uses the **GraphQL API** as the primary sync mechanism (efficient
multi-field fetches, cursor pagination, and access to Type/Field data that REST
does not expose), with REST used where convenient for repository discovery.

## Components

Each component has one clear responsibility and is independently testable.

### Config loader
Reads the YAML config, validates it against a Zod schema, and produces a typed
config object (tabs, groups, filters, display columns, fork allowlist, TTLs,
bind address). Fails fast at startup with actionable error messages on invalid
config or a missing/invalid PAT.

### Repo resolver
Turns the validated config into a concrete set of repositories and a tab-to-repo
mapping. Every tab has an operator-supplied **name** (used as the tab label).

A tab's repositories are the **union of one or more match rules**, and rule
types may be freely mixed within a single tab. For example a tab may combine
`org1/*` + `org2/*`, or `org1/*` + `org2/foo` + `org2/bar`. The rule types are:

- **Org rule:** expands an org into every repository the PAT can see in it
  (including private), via the GitHub API.
- **Explicit rule:** named `owner/name` repositories (for repos not related by
  an org). Explicit repos that no org/user rule discovered are fetched directly
  by `owner/name`, and an explicitly-named repo is included even if it is a fork
  or archived (explicit naming is an override).
- **Catch-all:** repositories owned by the operator's username that are **not**
  claimed by any other tab's rules. The catch-all is exclusionary so it acts as
  a true "leftovers" bucket. **If the catch-all matches no repositories, no tab
  is rendered for it.**

Regular tabs **may overlap** (the same repo can intentionally appear in more than
one tab); only the catch-all dedups against other tabs. In org/wildcard and
catch-all matches, **forks are excluded** unless listed on a global fork
allowlist, and **archived repositories are excluded**. Both exclusions are
overridden by naming a repo explicitly.

### GitHub client
A thin wrapper over GitHub's GraphQL API (plus REST for discovery). It is
rate-limit aware: it reads remaining budget (GraphQL `rateLimit` / REST headers),
backs off as the budget runs low, and never hammers the API. It exposes
operations for: listing org repos, fetching issues/PRs updated since a timestamp
(carrying their Type and custom Field values inline), discovering issue Type
definitions, and discovering custom Field definitions and their options.

### Sync engine
Checks per-repo TTL staleness and enqueues stale repos, processing them through
a **bounded worker pool** (configurable concurrency, default 6) to stay within
GitHub's secondary rate limits while avoiding slow serial round-trips. Sync is
**incremental**: it fetches issues updated since the last sync, ordered by
`updatedAt`, across all states so that issues which have transitioned to closed
are detected. Type/field **definitions** are discovered only on a repo's first
sync (and on an explicit rediscover such as the deep refresh), not on every
incremental sync, since they change rarely.

- Open issues and open PRs are upserted into the store.
- Issues that have become closed (or whose state is no longer open) are deleted
  along with their field values, since Seleya only retains open items.
- A periodic **deep refresh** (manual button, plus optional daily schedule)
  reconciles outright deletions and transfers by listing current open issues and
  removing local rows that have vanished.

The engine records per-repo sync state: last-synced timestamp, status
(idle/syncing/error), and last error message.

### Data store
The SQLite schema and a typed query layer over it.

**Core tables:**
- `repos` — discovered repositories (owner, name, id, is_fork, etc.).
- `issues` — open issues and PRs: number, repo, title, is_pull_request, state,
  author, assignees, labels (normalized, see below), milestone, timestamps,
  comment count, and a nullable `issue_type_id` / denormalized `issue_type_name`.
- `issue_labels` — normalized label membership (issue_id, label), so
  include/exclude label filters are clean SQL.
- `sync_state` — per-repo last-synced timestamp, status, and error.

**Beta-field tables (name-keyed EAV model):**
- `issue_types` — discovered Type definitions: node id (`IT_…`), name, color,
  description, defining scope.
- `field_definitions` — one row per discovered custom Field: node id
  (`IFSS_/IFMS_/IFN_/IFT_/IFD_`), name, `data_type`
  (single-select | multi-select | number | text | date), defining repo/org.
- `field_options` — option rows for select fields: node id (`IFSSO_…`), name,
  color, position.
- `issue_field_values` — the EAV value table:
  `(issue_id, field_name, data_type, value_text, value_number, value_date,
  option_id)`. Multi-select fields produce multiple rows. **`field_name` is
  denormalized onto each value row** so a single SQL filter spans all orgs
  uniformly despite per-org field IDs differing. Indexed on
  `(field_name, value_text)` and `(issue_id)`.

### Query engine
Compiles each group's structured filter into SQL over the store and assembles
the tab -> groups -> issues structure for the API. A tab with no configured
groups falls back to a single implicit group containing all open issues and PRs
for that tab's repos.

Supported filter dimensions (structured schema, evaluated locally):

- Labels: include / exclude.
- Item type: issue vs pull request.
- State (open by default; closed are not retained).
- Assignee, author, milestone, age.
- Issue **Type** (first-class, e.g. `Bug`, `Task`).
- Custom **Fields** by name: `in: [...]` for select fields, `op`/`value`
  comparisons for number fields, and `unset: true` for "no value set".

**Cross-org field matching is by field name, best-effort.** A filter on
`Priority` matches any issue whose `Priority` value qualifies, regardless of
which org defined the field. Issues in orgs lacking that field have no such value
(excluded by `in:`, included by `unset: true`). Two orgs that both define a field
of the same name but with different option sets both work; the operator lists the
option names they care about.

### HTTP API
Express JSON routes:
- Resolved tab list and, per tab, its groups and their issues (read from SQLite).
- Sync status (per repo / per tab), including remaining rate budget and any
  errors.
- A force-refresh trigger (per tab or global) and the deep-refresh trigger.

The same Express process serves the built React app as static files.

### Web UI
React 19 + Mantine 9 + TanStack Query/Table.

- Top-level **Mantine tabs**, one per configured tab.
- Within a tab, **stacked collapsible sections**, one per group, each a compact
  **sortable table** with a count badge. Columns are configurable and may include
  custom Fields by name; default columns include repo, title, labels, Type,
  assignee, age, and comment count. Select-field cells render with their option
  color.
- A **refresh indicator** shows when a sync is in progress, with per-repo/tab
  status. A **"reload when new data is ready"** checkbox causes TanStack Query to
  refetch once the in-progress sync completes. A **"Refresh now"** button forces
  an immediate sync regardless of TTL.

## Data flow and refresh behavior

1. Opening the UI (or a tab) requests that tab's data.
2. The API returns whatever is currently in SQLite **immediately**.
3. If any of the tab's repos are older than their TTL, the API kicks off a
   background sync for the stale repos.
4. The UI shows a "refreshing…" indicator and the sync status. If the operator
   has checked "reload when ready," the UI refetches once the sync completes.
5. "Refresh now" forces an immediate sync; the deep-refresh button forces a full
   reconciliation.

TTL is configurable: a global default with optional per-tab override. The default
is **10 minutes**.

## Beta-field discovery cost

`issueType` and `issueFieldValues` are nested inside the same issues GraphQL
query, so they add no per-issue requests. Field and Type **definitions** require
roughly two small extra GraphQL queries per repo per TTL, cached in the store.
The rate-limit impact is minimal. After a sync, the config loader can emit a soft
warning (not a failure) if a referenced field or option name is not defined by
any synced repo, catching typos.

## PAT permissions (to document)

Per the GraphQL behavior of issue Types/Fields (they live on the issue itself,
not Projects v2), no `project`/`read:project` scope is required.

- **Classic PAT** — public repos only: `public_repo` + `read:org`. Including
  private repos: `repo` (full) + `read:org`. `read:org` enables org repository
  enumeration and reading org-level Type/Field definitions.
- **Fine-grained PAT** — grant access to the specific orgs/repos (including
  private); repository permissions **Issues: Read** and **Metadata: Read** as the
  baseline. Note the operational wrinkle that fine-grained tokens must be approved
  per-org by an org owner.

The exact minimal fine-grained permission set will be **verified empirically
during implementation** and the documentation corrected to match, rather than
asserted from memory.

## Error handling

- Invalid config or a missing/invalid PAT: fail fast at startup with an
  actionable message.
- Rate-limit pressure: back off and defer syncs, surfacing remaining budget and
  next-retry in the UI.
- A single repo failing to sync: recorded against that repo and shown inline,
  without breaking the rest of the tab.
- Network errors: bounded retry with backoff.

## Testing strategy

- Unit tests for the high-logic pure pieces: config validation, repo resolution
  (precedence, catch-all, fork allowlist, overlap), and filter-to-SQL
  compilation (including the beta-field EAV cases).
- Sync engine tested against a mocked GitHub API (including incremental delta and
  closed-issue removal).
- Store tested against in-memory SQLite.
- Lighter component testing on the UI.

## Packaging and documentation

- **Apache 2.0**, with `LICENSE.md` (markdown form, already added) and a
  `NOTICE`.
- **README.md** — focused on what a random human happening upon the repo needs:
  purpose, what it does, setup, the example `config.yaml`, PAT/secrets handling,
  and the prominent security warning.
- **AGENTS.md** — orientation for a coding agent: architecture map, key
  components and their boundaries, how to run/test, conventions, and gotchas
  (e.g. beta fields only via GraphQL, name-keyed EAV model, localhost default).
- An example/annotated `config.yaml`.
- `.gitignore` covering the secrets file and the SQLite database.

## Explicitly out of scope for v1

- Closed-issue retention/history (closed items are removed).
- Writing back to GitHub (setting Types/Fields, commenting). Read-only for v1.
- Built-in authentication / multi-user (external gating only).
- A configuration UI (config is the YAML file; UI editing is a possible later
  phase).
- A raw GitHub-search-string filter escape hatch (structured filters only in v1).
