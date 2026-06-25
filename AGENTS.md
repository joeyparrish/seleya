# AGENTS.md

Orientation for coding agents working on Seleya. For user-facing setup, read
`README.md`.

## What Seleya is

A self-hosted, localhost-by-default web dashboard aggregating open GitHub issues
and PRs (including beta issue Types and custom Fields) across many repos and orgs
into configurable tabs and groups. TypeScript throughout, ESM, Node 20+.

## Architecture

SQLite is the source of truth. GitHub is read only by the sync/refresh path; the
read/serve path never calls GitHub.

Server (`src/server`):

- `config/` reads and validates `config.yaml` (Zod) and the token from the env.
- `db/` SQLite schema and typed stores: `repos`, `issues` (+ normalized
  `issue_labels`, assignees as JSON), the beta-field EAV tables (`issue_types`,
  `field_definitions`, `field_options`, `issue_field_values`), `sync_state`, and
  `tab_repos` (persisted tab membership).
- `github/` a GraphQL client (`@octokit/graphql`) for repo discovery, issue/PR
  fetch carrying Type and Field values, and Type/Field definition discovery.
- `resolver/` turns config into a concrete repo set and tab membership (org
  expansion, explicit repos, catch-all, fork/archived exclusion with explicit
  override).
- `sync/` the incremental sync engine (TTL staleness, bounded-concurrency worker
  pool, open-upsert/closed-delete via `applyFetchedIssues`).
- `query/` `filter.ts` compiles a group filter into SQL; `assemble.ts` builds
  `TabView`/`GroupView`/`IssueView`.
- `refresh/` `orchestrator.ts` (single-flight resolve + persist membership +
  sync, status tracking) and `reconcile.ts` (deep-refresh deletion reconciliation).
- `api/routes.ts` the Express JSON API; `server.ts` the entry point.

Client (`src/client`): React 19 + Mantine 9 + TanStack Query/Table, built by Vite
to `dist/client` and served by the server. `types.ts` mirrors the server view
types by hand (the client does not import server modules).

## Invariants (do not break)

- No authentication; bind `127.0.0.1` by default. The read path never calls
  GitHub. The token comes from `GITHUB_TOKEN`/`SELEYA_GITHUB_TOKEN`, never the
  config file. The DB and secrets are gitignored.
- Only open issues/PRs are retained; closed/removed items are deleted.
- Beta Types/Fields are GraphQL-only and modeled name-keyed EAV (cross-org
  matching is by field name).

## Running and testing

```bash
npm test                 # vitest (server only; the client has no unit tests)
npm run typecheck        # server tsc
npm run typecheck:client # client tsc
npm run build            # server tsc + vite build
GITHUB_TOKEN=$(gh auth token) npm run start
```

For a live smoke test, use a real token via `gh auth token` against the real
`config.yaml`/`seleya.db` rather than fabricated data.

## Gotchas

- `npm run sync` (the CLI) populates issues but does **not** persist tab
  membership; only a server refresh does. `GET /api/tabs` therefore triggers a
  background refresh when membership is empty as well as when data is stale.
- Type/Field **definitions** are discovered only on a repo's first sync or a deep
  refresh, not every incremental sync (a deliberate speed tradeoff). A newly
  added org field appears after the next first-sync of a repo or a deep refresh.
- The GraphQL issue-field-value query uses per-fragment aliases to avoid
  response-key type collisions (see `github/client.ts`); it is validated against
  the live API.
- Vitest strips types without type-checking, so always run `npm run typecheck`
  too; type errors (e.g. `RepoInfo` vs `RepoRow`) will pass tests but fail tsc.
- `docs/config-reference.md` is a hand-maintained, user-friendly mirror of the
  Zod config schema in `src/server/config/schema.ts`. When you change the schema
  (keys, types, defaults, operators, match/filter rules), update
  `docs/config-reference.md` to match, and keep `config.example.yaml` and the
  README config section consistent too. There is no generator; they drift if not
  updated together.
- Keep prose in docs free of em-dashes and double hyphens (repo owner preference).
