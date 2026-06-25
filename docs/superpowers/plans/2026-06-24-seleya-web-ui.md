# Seleya Web UI & Docs Implementation Plan (Plan 3 of 3)

> **For agentic workers:** Executed directly by the controller. Backend tasks end with `tsc --noEmit` + `vitest run` green; the UI is validated by building and running the app against the real API. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build the React 19 + Mantine 9 + TanStack web UI on top of the Plan 2 API — tabs, collapsible group sections, sortable issue tables, and the refresh indicator / "reload when ready" / "refresh now" controls — and write the project's README, AGENTS, and NOTICE.

**Architecture:** A Vite-built React SPA in `src/client/`, served as static files by the existing Express server (`SELEYA_CLIENT_DIR`). TanStack Query owns all server state (tabs, per-tab data, refresh status polling); TanStack Table powers per-group sortable tables; Mantine provides tabs, accordion sections, tables, and badges. The client talks only to the Plan 2 JSON API.

**Tech Stack:** Adds (devDeps) `vite`, `@vitejs/plugin-react`, `react`, `react-dom`, `@mantine/core`, `@mantine/hooks`, `@tanstack/react-query`, `@tanstack/react-table`, and types.

This is Plan 3 of 3, the final plan. The design spec is `docs/superpowers/specs/2026-06-24-seleya-issue-dashboard-design.md`. The API it builds on is documented in Plan 2.

## Global Constraints

- **The client talks only to the JSON API** (`/api/*`); it never holds a token or calls GitHub.
- **No new auth.** The server still binds localhost; the UI inherits that.
- **TypeScript strict, ESM, Node >= 20.** Commits use separate `git add <paths>` + `git commit` (never `git add -A`), ending with the trailer `Co-Authored-By: Claude Code (Claude Opus 4.8) <noreply@anthropic.com>`.
- **Use the latest Claude-appropriate library APIs:** React 19, Mantine 9, TanStack Query v5, TanStack Table v8. Verify current API shapes against docs where unsure (Mantine 9 `MantineProvider`/`ColorSchemeScript`, TanStack Query v5 `useQuery` object syntax).
- The server's existing `tsconfig.json` **excludes `src/client`**; the client is type-checked and built by Vite with its own `tsconfig.client.json`.

---

### Task 1: Client build scaffold

**Files:**
- `package.json` (add deps + `build:client`, `dev:client`, `build` → server+client scripts)
- `vite.config.ts`, `tsconfig.client.json`
- `src/client/index.html`, `src/client/main.tsx`, `src/client/App.tsx` (placeholder), `src/client/theme.ts`
- `.gitignore` (ensure `dist/` already covers the client build output — it does)

**Details:**
- Vite root is `src/client`; build `outDir` is `../../dist/client` (so the server's `SELEYA_CLIENT_DIR=dist/client` serves it). Dev server proxies `/api` → `http://127.0.0.1:<port>`.
- `main.tsx` mounts `<App/>` inside `<MantineProvider>` and a `<QueryClientProvider>`; include Mantine's `@mantine/core/styles.css` and `ColorSchemeScript`.
- `App.tsx` placeholder renders a Mantine `AppShell` with the title "Seleya".
- Scripts: `dev:client` = `vite`, `build:client` = `vite build`, `build` = `tsc -p tsconfig.json && vite build`. Keep `start` serving `dist/client` by defaulting `SELEYA_CLIENT_DIR` in `server.ts` to `dist/client` when it exists.

- [ ] Install deps; scaffold the files; `npm run build:client` produces `dist/client/index.html`; `npm run dev:client` boots. Commit (`Scaffold React client with Vite and Mantine`).

---

### Task 2: API client and shared view types

**Files:** `src/client/api.ts`, `src/client/types.ts`

**Details:**
- `types.ts` mirrors the server's `TabView`, `GroupView`, `IssueView`, `FieldView`, and `RefreshStatus` (copy the shapes; the client is a separate Vite project so it does not import server modules).
- `api.ts` exposes typed fetchers using `fetch`:
  - `getTabs(): Promise<{ tabs: { index: number; name: string }[] }>`
  - `getTab(index: number): Promise<TabView>`
  - `getRefreshStatus(): Promise<RefreshStatus>`
  - `postRefresh(deep: boolean): Promise<RefreshStatus>`
  - Each throws on non-2xx with the response text.

- [ ] Implement; commit (`Add client API layer and view types`). (No unit test; exercised by the UI and manual run.)

---

### Task 3: Tab navigation and data loading

**Files:** `src/client/App.tsx`, `src/client/components/TabsView.tsx`

**Details:**
- `App.tsx`: `useQuery({ queryKey: ['tabs'], queryFn: getTabs })`. Render Mantine `Tabs` with one `Tabs.Tab` per returned tab and a `Tabs.Panel` that mounts `<TabPanel index=.../>` (lazy: only the active panel fetches).
- `TabPanel`: `useQuery({ queryKey: ['tab', index], queryFn: () => getTab(index) })`. Loading → Mantine `Loader`; error → `Alert`. On success render the groups (Task 4).
- Show the `RefreshControls` (Task 5) in the header.

- [ ] Implement; verify tabs render against a running server; commit (`Add tab navigation and per-tab data loading`).

---

### Task 4: Group sections and issue tables

**Files:** `src/client/components/GroupSection.tsx`, `src/client/components/IssueTable.tsx`

**Details:**
- `GroupSection`: a Mantine `Accordion.Item` (default expanded) titled with the group name and a `Badge` showing the issue count. Empty groups render a muted "No matching issues".
- `IssueTable`: TanStack Table (`useReactTable`, `getCoreRowModel`, `getSortedRowModel`) rendered with Mantine `Table`. Columns:
  - Type icon (issue vs PR), `#number` + `title` as an external link to `issue.url`,
  - `repo`, `issueTypeName` (badge when present),
  - `labels` (badges), `fields` (one colored `Badge` per `FieldView`, using `optionColor` when set; numbers/dates rendered as text),
  - `assignees`, age (humanized from `createdAt`), `comments`.
  - Sortable by title, repo, age, comments at least. Default sort: updated desc (already the server order; table starts unsorted to preserve it).
- Map Mantine-known color names from GitHub option colors where possible; fall back to a neutral badge with the raw value.

- [ ] Implement; verify a real tab shows grouped, sortable issues with label/field badges; commit (`Add collapsible group sections and sortable issue tables`).

---

### Task 5: Refresh controls and status polling

**Files:** `src/client/components/RefreshControls.tsx`

**Details:**
- `useQuery({ queryKey: ['refreshStatus'], queryFn: getRefreshStatus, refetchInterval: q => q.state.data?.running ? 1500 : false })` — polls only while a refresh runs.
- UI: when `running`, show a `Loader` + text like "Refreshing N/Total…" and the `currentRepos`. When idle, show last finished time and any `lastError` as an `Alert`.
- A **"Reload when ready"** `Checkbox` (state held in `App`): when checked and a running→idle transition is observed, invalidate the `['tabs']` and `['tab', *]` queries so the visible data refetches.
- **"Refresh now"** and **"Deep refresh"** buttons → `postRefresh(false)` / `postRefresh(true)`, then invalidate `['refreshStatus']` to start polling.

- [ ] Implement; verify the indicator appears during a refresh and the checkbox reloads data on completion; commit (`Add refresh controls and status polling`).

---

### Task 6: Server integration and end-to-end run

**Files:** `src/server/server.ts` (default `SELEYA_CLIENT_DIR` to `dist/client` when present), `package.json` (`build` builds both)

**Details:**
- `server.ts`: if `SELEYA_CLIENT_DIR` is unset, default to `dist/client` when that directory exists, else stay API-only.
- Verify: `npm run build` (server + client), then `GITHUB_TOKEN=$(gh auth token) npm run start`, open `http://127.0.0.1:<port>` and confirm tabs, groups, issues, beta fields, and a manual "Refresh now" all work in the browser.

- [ ] Implement + run; commit (`Serve the built client from the server`).

---

### Task 7: Project documentation

**Files:** `README.md`, `AGENTS.md`, `NOTICE`

**Details:**
- `README.md` — for a human who finds the repo: what Seleya is; the prominent **no-auth / localhost-only / gate private repos** warning; quick start (`npm install`, copy `config.example.yaml` to `config.yaml`, `export GITHUB_TOKEN` / `gh auth token`, `npm run build`, `npm run start`); the **PAT scopes** (classic `repo` + `read:org` for private, `public_repo` + `read:org` for public; no `project` scope; fine-grained: Issues:Read + Metadata:Read, verified during build); config reference (tabs, match rules incl. archived/fork behavior, groups/filters incl. beta fields, TTL, concurrency); how refresh/TTL and deep refresh work; the CLI `npm run sync`.
- `AGENTS.md` — for a coding agent: architecture map (server `config`/`db`/`github`/`resolver`/`sync`/`query`/`refresh`/`api`, client), the SQLite-as-source-of-truth + name-keyed EAV model, GraphQL-only beta fields, localhost/no-auth invariant, how to run tests/build/serve, and the gotchas (CLI doesn't persist membership; discovery only on first sync; `gh auth token` for local runs).
- `NOTICE` — Apache 2.0 attribution notice for Seleya.

- [ ] Write the docs; commit (`Add README, AGENTS, and NOTICE`).

## Manual verification (end of Plan 3)

`npm run build` then `GITHUB_TOKEN=$(gh auth token) npm run start`; in the browser confirm: tabs load; groups are collapsible with counts; issue tables sort; labels and beta fields (e.g. Defin3D Priority) render as colored badges; "Refresh now" shows the indicator and "reload when ready" refreshes the data.

## Coverage against the spec (self-review)

- React 19 + Mantine 9 + TanStack: Tasks 1-5.
- Top-level tabs; stacked collapsible group sections with counts; compact sortable tables: Tasks 3-4.
- Custom-field columns with option colors: Task 4.
- Refresh indicator + "reload when ready" + "refresh now" (+ deep refresh): Task 5.
- Served from the same server, localhost: Task 6.
- Apache 2.0 README/AGENTS/NOTICE incl. security warning + PAT scopes: Task 7.
- Deferred/refinements: configurable `display.columns` per the spec (Plan 3 ships a sensible default column set incl. a fields column); per-tab TTL staleness (global TTL used); a config-editing UI (config file remains the source of truth).
