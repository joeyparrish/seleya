# Seleya Backend & Ingestion Implementation Plan (Plan 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the backend foundation that ingests open issues and PRs (including beta Types/Fields) from many GitHub repos into a local SQLite database, driven by a YAML config, exposed as a `seleya sync` CLI.

**Architecture:** A TypeScript/ESM Node app. A Zod-validated YAML config defines tabs and match rules. A repo resolver expands those rules (via GitHub GraphQL) into a concrete repo set. A GraphQL client fetches issues/PRs incrementally. A sync engine writes them into SQLite (better-sqlite3) as the source of truth, removing items that have closed. Beta Types/Fields are stored in a name-keyed EAV model.

**Tech Stack:** TypeScript (strict, ESM), Node >= 20, better-sqlite3, Zod, the `yaml` package, `@octokit/graphql`, Vitest, tsx (dev/CLI runner), tsc (build).

This plan is Plan 1 of 2. Plan 2 (query engine, Express API, React/Mantine UI, docs) is written after this plan is implemented, so the database schema is proven before the read/serve layer is built on top of it.

The design spec is at `docs/superpowers/specs/2026-06-24-seleya-issue-dashboard-design.md`. Read it before starting.

## Global Constraints

These apply to every task. Copied from the spec.

- **No built-in authentication.** This plan has no network surface yet, but the eventual server binds `127.0.0.1` by default. Do not add auth.
- **PAT comes from the environment** (`GITHUB_TOKEN`, falling back to `SELEYA_GITHUB_TOKEN`), never from the committed config file.
- **The SQLite database file and any secrets file must be gitignored.**
- **GraphQL is the primary GitHub API.** Issue Types/Fields live on the issue itself, so no `project`/`read:project` scope is needed.
- **Only open issues and open PRs are retained.** When an item is no longer open, it is deleted from the store along with its labels and field values.
- **Default TTL is 10 minutes.**
- **Language:** TypeScript strict mode, ESM (`"type": "module"`), Node >= 20.
- **Commits:** use separate `git add <paths>` and `git commit` commands (never `git add -A`); end every commit message with a trailer line `Co-Authored-By: Claude Code (Claude Opus 4.8) <noreply@anthropic.com>`.
- **The GraphQL field-value selection follows the `github-issue-fields` skill recipe.** Per-fragment aliases are used to avoid response-key type collisions; verify the exact selection against the live API during this plan and correct if GitHub's schema differs.

---

### Task 1: Project scaffold and tooling

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `src/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a working `npm test`, `npm run build`, and `npm run sync` script wiring; the `src/` tree.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "seleya",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "license": "Apache-2.0",
  "engines": { "node": ">=20" },
  "bin": { "seleya": "dist/server/cli.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "sync": "tsx src/server/cli.ts"
  },
  "dependencies": {
    "@octokit/graphql": "^8.1.1",
    "better-sqlite3": "^11.3.0",
    "yaml": "^2.5.1",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^22.5.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.2",
    "vitest": "^2.1.1"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src"],
  "exclude": ["src/client"]
}
```

- [ ] **Step 3: Write `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 4: Write `.gitignore`**

```gitignore
node_modules/
dist/
*.tsbuildinfo

# Local data and secrets (contain private repo data / credentials)
*.sqlite
*.sqlite-shm
*.sqlite-wal
seleya.db
config.yaml
.env
secrets.*
```

- [ ] **Step 5: Write the smoke test `src/smoke.test.ts`**

```ts
import { describe, it, expect } from "vitest";

describe("smoke", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 6: Install and run the smoke test**

Run: `npm install`
Then run: `npm test`
Expected: 1 passing test.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore src/smoke.test.ts
git commit -m "Scaffold Seleya TypeScript project with Vitest"
```
(Append the required Co-Authored-By trailer.)

---

### Task 2: Config schema and loader

**Files:**
- Create: `src/server/config/schema.ts`
- Create: `src/server/config/load.ts`
- Create: `config.example.yaml`
- Test: `src/server/config/load.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `Config` type and `configSchema` (Zod) from `schema.ts`, with these shapes:
    - `MatchRule = { org: string } | { repos: string[] } | { catchAll: true }`
    - `FieldFilter = { name: string; in?: string[]; op?: ">"|">="|"<"|"<="|"="|"!="; value?: number; unset?: boolean }`
    - `GroupFilter = { labelsInclude?: string[]; labelsExclude?: string[]; type?: "issue"|"pull_request"; assignee?: string; author?: string; milestone?: string; ageDays?: { op: ">"|">="|"<"|"<="; value: number }; issueType?: string[]; fields?: FieldFilter[] }`
    - `Group = { name: string; filter?: GroupFilter }`
    - `Tab = { name: string; match: MatchRule[]; groups?: Group[]; ttlMinutes?: number }`
    - `Config = { username: string; ttlMinutes: number; bindAddress: string; port: number; forkAllowlist: string[]; tabs: Tab[] }`
  - `loadConfig(opts?: { path?: string; env?: NodeJS.ProcessEnv }): { config: Config; token: string }` from `load.ts`.

- [ ] **Step 1: Write the failing test `src/server/config/load.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "./load.js";

function writeConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "seleya-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, contents);
  return path;
}

const valid = `
username: octocat
tabs:
  - name: Shaka
    match:
      - org: shaka-project
  - name: Personal
    match:
      - catchAll: true
`;

describe("loadConfig", () => {
  it("parses a valid config and applies defaults", () => {
    const path = writeConfig(valid);
    const { config, token } = loadConfig({ path, env: { GITHUB_TOKEN: "tok" } });
    expect(config.username).toBe("octocat");
    expect(config.ttlMinutes).toBe(10);
    expect(config.bindAddress).toBe("127.0.0.1");
    expect(config.port).toBe(8080);
    expect(config.forkAllowlist).toEqual([]);
    expect(config.tabs).toHaveLength(2);
    expect(token).toBe("tok");
  });

  it("reads the token from SELEYA_GITHUB_TOKEN as a fallback", () => {
    const path = writeConfig(valid);
    const { token } = loadConfig({ path, env: { SELEYA_GITHUB_TOKEN: "fallback" } });
    expect(token).toBe("fallback");
  });

  it("throws a clear error when the token is missing", () => {
    const path = writeConfig(valid);
    expect(() => loadConfig({ path, env: {} })).toThrow(/GITHUB_TOKEN/);
  });

  it("throws a validation error for a tab missing a name", () => {
    const path = writeConfig(`username: octocat\ntabs:\n  - match:\n      - org: x\n`);
    expect(() => loadConfig({ path, env: { GITHUB_TOKEN: "tok" } })).toThrow();
  });

  it("rejects an explicit repo not in owner/name form", () => {
    const path = writeConfig(
      `username: octocat\ntabs:\n  - name: T\n    match:\n      - repos: [\"notslashed\"]\n`,
    );
    expect(() => loadConfig({ path, env: { GITHUB_TOKEN: "tok" } })).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/server/config/load.test.ts`
Expected: FAIL — cannot find module `./load.js`.

- [ ] **Step 3: Write `src/server/config/schema.ts`**

```ts
import { z } from "zod";

const repoName = z.string().regex(/^[^/]+\/[^/]+$/, "must be in owner/name form");

const orgRule = z.object({ org: z.string().min(1) }).strict();
const reposRule = z.object({ repos: z.array(repoName).min(1) }).strict();
const catchAllRule = z.object({ catchAll: z.literal(true) }).strict();
export const matchRuleSchema = z.union([orgRule, reposRule, catchAllRule]);

const comparison = z.enum([">", ">=", "<", "<="]);

export const fieldFilterSchema = z
  .object({
    name: z.string().min(1),
    in: z.array(z.string()).optional(),
    op: z.enum([">", ">=", "<", "<=", "=", "!="]).optional(),
    value: z.number().optional(),
    unset: z.boolean().optional(),
  })
  .strict();

export const groupFilterSchema = z
  .object({
    labelsInclude: z.array(z.string()).optional(),
    labelsExclude: z.array(z.string()).optional(),
    type: z.enum(["issue", "pull_request"]).optional(),
    assignee: z.string().optional(),
    author: z.string().optional(),
    milestone: z.string().optional(),
    ageDays: z.object({ op: comparison, value: z.number() }).strict().optional(),
    issueType: z.array(z.string()).optional(),
    fields: z.array(fieldFilterSchema).optional(),
  })
  .strict();

export const groupSchema = z
  .object({ name: z.string().min(1), filter: groupFilterSchema.optional() })
  .strict();

export const tabSchema = z
  .object({
    name: z.string().min(1),
    match: z.array(matchRuleSchema).min(1),
    groups: z.array(groupSchema).optional(),
    ttlMinutes: z.number().int().positive().optional(),
  })
  .strict();

export const configSchema = z
  .object({
    username: z.string().min(1),
    ttlMinutes: z.number().int().positive().default(10),
    bindAddress: z.string().default("127.0.0.1"),
    port: z.number().int().positive().default(8080),
    forkAllowlist: z.array(repoName).default([]),
    tabs: z.array(tabSchema).min(1),
  })
  .strict();

export type MatchRule = z.infer<typeof matchRuleSchema>;
export type FieldFilter = z.infer<typeof fieldFilterSchema>;
export type GroupFilter = z.infer<typeof groupFilterSchema>;
export type Group = z.infer<typeof groupSchema>;
export type Tab = z.infer<typeof tabSchema>;
export type Config = z.infer<typeof configSchema>;
```

- [ ] **Step 4: Write `src/server/config/load.ts`**

```ts
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { configSchema, type Config } from "./schema.js";

export interface LoadedConfig {
  config: Config;
  token: string;
}

export function loadConfig(opts?: {
  path?: string;
  env?: NodeJS.ProcessEnv;
}): LoadedConfig {
  const env = opts?.env ?? process.env;
  const path = opts?.path ?? env.SELEYA_CONFIG ?? "config.yaml";

  const raw = readFileSync(path, "utf8");
  const parsed = parseYaml(raw);
  const config = configSchema.parse(parsed);

  const token = env.GITHUB_TOKEN ?? env.SELEYA_GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "No GitHub token found. Set GITHUB_TOKEN (or SELEYA_GITHUB_TOKEN) in the environment.",
    );
  }

  return { config, token };
}
```

- [ ] **Step 5: Write `config.example.yaml`**

```yaml
# Seleya configuration. Copy to config.yaml and edit.
# The GitHub PAT is NOT set here; export GITHUB_TOKEN in the environment.

username: your-github-username   # used to compute the catch-all tab
ttlMinutes: 10                   # global default staleness; per-tab override allowed
bindAddress: 127.0.0.1           # do NOT expose publicly without external auth
port: 8080

forkAllowlist:
  - some-owner/a-fork-worth-keeping

tabs:
  - name: Shaka Project
    match:
      - org: shaka-project
    groups:
      - name: Needs triage
        filter:
          labelsExclude: [triaged]
          type: issue
      - name: High priority
        filter:
          fields:
            - name: Priority
              in: [High, Critical]

  - name: Mixed
    match:
      - org: some-org
      - repos: [another-owner/foo, another-owner/bar]

  - name: Personal
    match:
      - catchAll: true
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/server/config/load.test.ts`
Expected: all 5 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server/config/schema.ts src/server/config/load.ts src/server/config/load.test.ts config.example.yaml
git commit -m "Add Zod config schema and YAML loader"
```
(Append the Co-Authored-By trailer.)

---

### Task 3: Database open and schema

**Files:**
- Create: `src/server/db/schema.ts`
- Create: `src/server/db/database.ts`
- Test: `src/server/db/database.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `SCHEMA_SQL: string` from `schema.ts`.
  - `openDatabase(path: string): Database.Database` from `database.ts` — opens (or creates) the DB, enables WAL + foreign keys, and applies the schema idempotently. Pass `":memory:"` in tests. Type is `better-sqlite3`'s `Database`.

- [ ] **Step 1: Write the failing test `src/server/db/database.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { openDatabase } from "./database.js";
import { SCHEMA_SQL } from "./schema.js";

describe("openDatabase", () => {
  it("creates all expected tables", () => {
    const db = openDatabase(":memory:");
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);
    for (const t of [
      "repos",
      "issues",
      "issue_labels",
      "issue_types",
      "field_definitions",
      "field_options",
      "issue_field_values",
      "sync_state",
    ]) {
      expect(names).toContain(t);
    }
  });

  it("enables foreign key enforcement", () => {
    const db = openDatabase(":memory:");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("is idempotent when applied twice", () => {
    const db = openDatabase(":memory:");
    expect(() => db.exec(SCHEMA_SQL)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/server/db/database.test.ts`
Expected: FAIL — cannot find module `./database.js`.

- [ ] **Step 3: Write `src/server/db/schema.ts`**

```ts
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  is_fork INTEGER NOT NULL DEFAULT 0,
  UNIQUE(owner, name)
);

CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  is_pull_request INTEGER NOT NULL,
  state TEXT NOT NULL,
  author TEXT,
  assignees TEXT NOT NULL DEFAULT '[]',
  milestone TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  comments INTEGER NOT NULL DEFAULT 0,
  issue_type_id TEXT,
  issue_type_name TEXT
);
CREATE INDEX IF NOT EXISTS idx_issues_repo ON issues(repo_id);
CREATE INDEX IF NOT EXISTS idx_issues_updated ON issues(updated_at);

CREATE TABLE IF NOT EXISTS issue_labels (
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  PRIMARY KEY (issue_id, label)
);
CREATE INDEX IF NOT EXISTS idx_issue_labels_label ON issue_labels(label);

CREATE TABLE IF NOT EXISTS issue_types (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT,
  description TEXT
);

CREATE TABLE IF NOT EXISTS field_definitions (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  data_type TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_field_defs_repo ON field_definitions(repo_id);

CREATE TABLE IF NOT EXISTS field_options (
  id TEXT PRIMARY KEY,
  field_definition_id TEXT NOT NULL REFERENCES field_definitions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT,
  position INTEGER
);

CREATE TABLE IF NOT EXISTS issue_field_values (
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL,
  data_type TEXT NOT NULL,
  value_text TEXT,
  value_number REAL,
  value_date TEXT,
  option_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_ifv_issue ON issue_field_values(issue_id);
CREATE INDEX IF NOT EXISTS idx_ifv_name_text ON issue_field_values(field_name, value_text);

CREATE TABLE IF NOT EXISTS sync_state (
  repo_id TEXT PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  last_synced_at TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  error TEXT
);
`;
```

- [ ] **Step 4: Write `src/server/db/database.ts`**

```ts
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "./schema.js";

export function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/server/db/database.test.ts`
Expected: all 3 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/db/schema.ts src/server/db/database.ts src/server/db/database.test.ts
git commit -m "Add SQLite schema and database opener"
```
(Append the Co-Authored-By trailer.)

---

### Task 4: Repo store

**Files:**
- Create: `src/server/db/repos.ts`
- Test: `src/server/db/repos.test.ts`

**Interfaces:**
- Consumes: `openDatabase` (Task 3).
- Produces, from `repos.ts`:
  - `interface RepoRow { id: string; owner: string; name: string; isFork: boolean }`
  - `upsertRepo(db: Database.Database, repo: RepoRow): void`
  - `getRepo(db: Database.Database, owner: string, name: string): RepoRow | undefined`
  - `listRepos(db: Database.Database): RepoRow[]`

- [ ] **Step 1: Write the failing test `src/server/db/repos.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { openDatabase } from "./database.js";
import { upsertRepo, getRepo, listRepos } from "./repos.js";

describe("repo store", () => {
  it("inserts and reads a repo", () => {
    const db = openDatabase(":memory:");
    upsertRepo(db, { id: "R_1", owner: "shaka-project", name: "shaka-player", isFork: false });
    expect(getRepo(db, "shaka-project", "shaka-player")).toEqual({
      id: "R_1",
      owner: "shaka-project",
      name: "shaka-player",
      isFork: false,
    });
  });

  it("updates on conflicting id", () => {
    const db = openDatabase(":memory:");
    upsertRepo(db, { id: "R_1", owner: "o", name: "n", isFork: false });
    upsertRepo(db, { id: "R_1", owner: "o", name: "n", isFork: true });
    expect(getRepo(db, "o", "n")?.isFork).toBe(true);
    expect(listRepos(db)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/server/db/repos.test.ts`
Expected: FAIL — cannot find module `./repos.js`.

- [ ] **Step 3: Write `src/server/db/repos.ts`**

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/server/db/repos.test.ts`
Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/db/repos.ts src/server/db/repos.test.ts
git commit -m "Add repo store"
```
(Append the Co-Authored-By trailer.)

---

### Task 5: Issue store

**Files:**
- Create: `src/server/db/issues.ts`
- Test: `src/server/db/issues.test.ts`

**Interfaces:**
- Consumes: `openDatabase` (Task 3), `upsertRepo`/`RepoRow` (Task 4).
- Produces, from `issues.ts`:
  - `interface IssueRecord { id: string; repoId: string; number: number; title: string; isPullRequest: boolean; state: string; author: string | null; assignees: string[]; labels: string[]; milestone: string | null; createdAt: string; updatedAt: string; comments: number; issueTypeId: string | null; issueTypeName: string | null }`
  - `upsertIssue(db: Database.Database, issue: IssueRecord): void` — upserts the row and **replaces** the issue's label rows.
  - `deleteIssue(db: Database.Database, id: string): void`
  - `listIssueIdsByRepo(db: Database.Database, repoId: string): string[]`
  - `getIssue(db: Database.Database, id: string): IssueRecord | undefined`

- [ ] **Step 1: Write the failing test `src/server/db/issues.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { openDatabase } from "./database.js";
import { upsertRepo } from "./repos.js";
import {
  upsertIssue,
  deleteIssue,
  getIssue,
  listIssueIdsByRepo,
  type IssueRecord,
} from "./issues.js";

function seedRepo(db: ReturnType<typeof openDatabase>) {
  upsertRepo(db, { id: "R_1", owner: "o", name: "n", isFork: false });
}

const base: IssueRecord = {
  id: "I_1",
  repoId: "R_1",
  number: 7,
  title: "Bug",
  isPullRequest: false,
  state: "OPEN",
  author: "alice",
  assignees: ["bob"],
  labels: ["bug", "triaged"],
  milestone: "v1",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  comments: 3,
  issueTypeId: "IT_1",
  issueTypeName: "Bug",
};

describe("issue store", () => {
  it("round-trips an issue with labels and assignees", () => {
    const db = openDatabase(":memory:");
    seedRepo(db);
    upsertIssue(db, base);
    expect(getIssue(db, "I_1")).toEqual(base);
  });

  it("replaces labels on re-upsert rather than accumulating", () => {
    const db = openDatabase(":memory:");
    seedRepo(db);
    upsertIssue(db, base);
    upsertIssue(db, { ...base, labels: ["wontfix"] });
    expect(getIssue(db, "I_1")?.labels).toEqual(["wontfix"]);
  });

  it("deletes an issue and cascades its labels", () => {
    const db = openDatabase(":memory:");
    seedRepo(db);
    upsertIssue(db, base);
    deleteIssue(db, "I_1");
    expect(getIssue(db, "I_1")).toBeUndefined();
    const labelCount = db
      .prepare("SELECT COUNT(*) AS c FROM issue_labels WHERE issue_id='I_1'")
      .get() as { c: number };
    expect(labelCount.c).toBe(0);
  });

  it("lists issue ids for a repo", () => {
    const db = openDatabase(":memory:");
    seedRepo(db);
    upsertIssue(db, base);
    upsertIssue(db, { ...base, id: "I_2", number: 8 });
    expect(listIssueIdsByRepo(db, "R_1").sort()).toEqual(["I_1", "I_2"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/server/db/issues.test.ts`
Expected: FAIL — cannot find module `./issues.js`.

- [ ] **Step 3: Write `src/server/db/issues.ts`**

```ts
import type Database from "better-sqlite3";

export interface IssueRecord {
  id: string;
  repoId: string;
  number: number;
  title: string;
  isPullRequest: boolean;
  state: string;
  author: string | null;
  assignees: string[];
  labels: string[];
  milestone: string | null;
  createdAt: string;
  updatedAt: string;
  comments: number;
  issueTypeId: string | null;
  issueTypeName: string | null;
}

interface RawIssue {
  id: string;
  repo_id: string;
  number: number;
  title: string;
  is_pull_request: number;
  state: string;
  author: string | null;
  assignees: string;
  milestone: string | null;
  created_at: string;
  updated_at: string;
  comments: number;
  issue_type_id: string | null;
  issue_type_name: string | null;
}

export function upsertIssue(db: Database.Database, issue: IssueRecord): void {
  const tx = db.transaction((i: IssueRecord) => {
    db.prepare(
      `INSERT INTO issues
         (id, repo_id, number, title, is_pull_request, state, author, assignees,
          milestone, created_at, updated_at, comments, issue_type_id, issue_type_name)
       VALUES
         (@id, @repo_id, @number, @title, @is_pull_request, @state, @author, @assignees,
          @milestone, @created_at, @updated_at, @comments, @issue_type_id, @issue_type_name)
       ON CONFLICT(id) DO UPDATE SET
         repo_id=@repo_id, number=@number, title=@title, is_pull_request=@is_pull_request,
         state=@state, author=@author, assignees=@assignees, milestone=@milestone,
         created_at=@created_at, updated_at=@updated_at, comments=@comments,
         issue_type_id=@issue_type_id, issue_type_name=@issue_type_name`,
    ).run({
      id: i.id,
      repo_id: i.repoId,
      number: i.number,
      title: i.title,
      is_pull_request: i.isPullRequest ? 1 : 0,
      state: i.state,
      author: i.author,
      assignees: JSON.stringify(i.assignees),
      milestone: i.milestone,
      created_at: i.createdAt,
      updated_at: i.updatedAt,
      comments: i.comments,
      issue_type_id: i.issueTypeId,
      issue_type_name: i.issueTypeName,
    });

    db.prepare("DELETE FROM issue_labels WHERE issue_id=?").run(i.id);
    const insLabel = db.prepare("INSERT INTO issue_labels (issue_id, label) VALUES (?, ?)");
    for (const label of i.labels) insLabel.run(i.id, label);
  });
  tx(issue);
}

export function deleteIssue(db: Database.Database, id: string): void {
  db.prepare("DELETE FROM issues WHERE id=?").run(id);
}

export function listIssueIdsByRepo(db: Database.Database, repoId: string): string[] {
  const rows = db
    .prepare("SELECT id FROM issues WHERE repo_id=?")
    .all(repoId) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

export function getIssue(db: Database.Database, id: string): IssueRecord | undefined {
  const row = db.prepare("SELECT * FROM issues WHERE id=?").get(id) as RawIssue | undefined;
  if (!row) return undefined;
  const labels = (
    db.prepare("SELECT label FROM issue_labels WHERE issue_id=? ORDER BY label").all(id) as Array<{
      label: string;
    }>
  ).map((r) => r.label);
  return {
    id: row.id,
    repoId: row.repo_id,
    number: row.number,
    title: row.title,
    isPullRequest: row.is_pull_request === 1,
    state: row.state,
    author: row.author,
    assignees: JSON.parse(row.assignees) as string[],
    labels,
    milestone: row.milestone,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    comments: row.comments,
    issueTypeId: row.issue_type_id,
    issueTypeName: row.issue_type_name,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/server/db/issues.test.ts`
Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/db/issues.ts src/server/db/issues.test.ts
git commit -m "Add issue store with normalized labels"
```
(Append the Co-Authored-By trailer.)

---

### Task 6: Field and type store

**Files:**
- Create: `src/server/db/fields.ts`
- Test: `src/server/db/fields.test.ts`

**Interfaces:**
- Consumes: `openDatabase` (Task 3), repo + issue stores (Tasks 4-5).
- Produces, from `fields.ts`:
  - `interface IssueTypeDef { id: string; name: string; color: string | null; description: string | null }`
  - `interface FieldOptionDef { id: string; name: string; color: string | null; position: number | null }`
  - `interface FieldDef { id: string; repoId: string; name: string; dataType: "single_select" | "multi_select" | "number" | "text" | "date"; options: FieldOptionDef[] }`
  - `interface IssueFieldValue { fieldName: string; dataType: FieldDef["dataType"]; valueText?: string | null; valueNumber?: number | null; valueDate?: string | null; optionId?: string | null }`
  - `upsertIssueType(db, t: IssueTypeDef): void`
  - `upsertFieldDefinition(db, f: FieldDef): void` — upserts the definition and replaces its options.
  - `setIssueFieldValues(db, issueId: string, values: IssueFieldValue[]): void` — replaces all field values for the issue.
  - `getFieldValues(db, issueId: string): IssueFieldValue[]`
  - `listFieldDefinitions(db): FieldDef[]`

- [ ] **Step 1: Write the failing test `src/server/db/fields.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { openDatabase } from "./database.js";
import { upsertRepo } from "./repos.js";
import { upsertIssue, type IssueRecord } from "./issues.js";
import {
  upsertIssueType,
  upsertFieldDefinition,
  setIssueFieldValues,
  getFieldValues,
  listFieldDefinitions,
  type IssueFieldValue,
} from "./fields.js";

function seed(db: ReturnType<typeof openDatabase>) {
  upsertRepo(db, { id: "R_1", owner: "o", name: "n", isFork: false });
  const issue: IssueRecord = {
    id: "I_1", repoId: "R_1", number: 1, title: "t", isPullRequest: false, state: "OPEN",
    author: null, assignees: [], labels: [], milestone: null,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    comments: 0, issueTypeId: null, issueTypeName: null,
  };
  upsertIssue(db, issue);
}

describe("field store", () => {
  it("stores a field definition with options", () => {
    const db = openDatabase(":memory:");
    seed(db);
    upsertFieldDefinition(db, {
      id: "IFSS_1", repoId: "R_1", name: "Priority", dataType: "single_select",
      options: [
        { id: "IFSSO_1", name: "High", color: "RED", position: 0 },
        { id: "IFSSO_2", name: "Low", color: "GREEN", position: 1 },
      ],
    });
    const defs = listFieldDefinitions(db);
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("Priority");
    expect(defs[0].options.map((o) => o.name)).toEqual(["High", "Low"]);
  });

  it("replaces options on re-upsert", () => {
    const db = openDatabase(":memory:");
    seed(db);
    const def = (opts: any) => ({
      id: "IFSS_1", repoId: "R_1", name: "Priority", dataType: "single_select" as const, options: opts,
    });
    upsertFieldDefinition(db, def([{ id: "IFSSO_1", name: "High", color: null, position: 0 }]));
    upsertFieldDefinition(db, def([{ id: "IFSSO_2", name: "Low", color: null, position: 0 }]));
    expect(listFieldDefinitions(db)[0].options.map((o) => o.name)).toEqual(["Low"]);
  });

  it("replaces issue field values and reads them back", () => {
    const db = openDatabase(":memory:");
    seed(db);
    const values: IssueFieldValue[] = [
      { fieldName: "Priority", dataType: "single_select", valueText: "High", optionId: "IFSSO_1" },
      { fieldName: "Effort", dataType: "number", valueNumber: 5 },
    ];
    setIssueFieldValues(db, "I_1", values);
    setIssueFieldValues(db, "I_1", [
      { fieldName: "Priority", dataType: "single_select", valueText: "Low", optionId: "IFSSO_2" },
    ]);
    const back = getFieldValues(db, "I_1");
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ fieldName: "Priority", valueText: "Low", optionId: "IFSSO_2" });
  });

  it("stores an issue type", () => {
    const db = openDatabase(":memory:");
    seed(db);
    upsertIssueType(db, { id: "IT_1", name: "Bug", color: "RED", description: null });
    const row = db.prepare("SELECT name FROM issue_types WHERE id='IT_1'").get() as { name: string };
    expect(row.name).toBe("Bug");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/server/db/fields.test.ts`
Expected: FAIL — cannot find module `./fields.js`.

- [ ] **Step 3: Write `src/server/db/fields.ts`**

```ts
import type Database from "better-sqlite3";

export interface IssueTypeDef {
  id: string;
  name: string;
  color: string | null;
  description: string | null;
}

export interface FieldOptionDef {
  id: string;
  name: string;
  color: string | null;
  position: number | null;
}

export type FieldDataType = "single_select" | "multi_select" | "number" | "text" | "date";

export interface FieldDef {
  id: string;
  repoId: string;
  name: string;
  dataType: FieldDataType;
  options: FieldOptionDef[];
}

export interface IssueFieldValue {
  fieldName: string;
  dataType: FieldDataType;
  valueText?: string | null;
  valueNumber?: number | null;
  valueDate?: string | null;
  optionId?: string | null;
}

export function upsertIssueType(db: Database.Database, t: IssueTypeDef): void {
  db.prepare(
    `INSERT INTO issue_types (id, name, color, description)
     VALUES (@id, @name, @color, @description)
     ON CONFLICT(id) DO UPDATE SET name=@name, color=@color, description=@description`,
  ).run(t);
}

export function upsertFieldDefinition(db: Database.Database, f: FieldDef): void {
  const tx = db.transaction((def: FieldDef) => {
    db.prepare(
      `INSERT INTO field_definitions (id, repo_id, name, data_type)
       VALUES (@id, @repo_id, @name, @data_type)
       ON CONFLICT(id) DO UPDATE SET repo_id=@repo_id, name=@name, data_type=@data_type`,
    ).run({ id: def.id, repo_id: def.repoId, name: def.name, data_type: def.dataType });

    db.prepare("DELETE FROM field_options WHERE field_definition_id=?").run(def.id);
    const ins = db.prepare(
      `INSERT INTO field_options (id, field_definition_id, name, color, position)
       VALUES (@id, @field_definition_id, @name, @color, @position)`,
    );
    for (const o of def.options) {
      ins.run({
        id: o.id,
        field_definition_id: def.id,
        name: o.name,
        color: o.color,
        position: o.position,
      });
    }
  });
  tx(f);
}

export function setIssueFieldValues(
  db: Database.Database,
  issueId: string,
  values: IssueFieldValue[],
): void {
  const tx = db.transaction((vals: IssueFieldValue[]) => {
    db.prepare("DELETE FROM issue_field_values WHERE issue_id=?").run(issueId);
    const ins = db.prepare(
      `INSERT INTO issue_field_values
         (issue_id, field_name, data_type, value_text, value_number, value_date, option_id)
       VALUES (@issue_id, @field_name, @data_type, @value_text, @value_number, @value_date, @option_id)`,
    );
    for (const v of vals) {
      ins.run({
        issue_id: issueId,
        field_name: v.fieldName,
        data_type: v.dataType,
        value_text: v.valueText ?? null,
        value_number: v.valueNumber ?? null,
        value_date: v.valueDate ?? null,
        option_id: v.optionId ?? null,
      });
    }
  });
  tx(values);
}

export function getFieldValues(db: Database.Database, issueId: string): IssueFieldValue[] {
  const rows = db
    .prepare("SELECT * FROM issue_field_values WHERE issue_id=?")
    .all(issueId) as Array<{
    field_name: string;
    data_type: FieldDataType;
    value_text: string | null;
    value_number: number | null;
    value_date: string | null;
    option_id: string | null;
  }>;
  return rows.map((r) => ({
    fieldName: r.field_name,
    dataType: r.data_type,
    valueText: r.value_text,
    valueNumber: r.value_number,
    valueDate: r.value_date,
    optionId: r.option_id,
  }));
}

export function listFieldDefinitions(db: Database.Database): FieldDef[] {
  const defs = db
    .prepare("SELECT id, repo_id, name, data_type FROM field_definitions ORDER BY name")
    .all() as Array<{ id: string; repo_id: string; name: string; data_type: FieldDataType }>;
  const optStmt = db.prepare(
    "SELECT id, name, color, position FROM field_options WHERE field_definition_id=? ORDER BY position, name",
  );
  return defs.map((d) => ({
    id: d.id,
    repoId: d.repo_id,
    name: d.name,
    dataType: d.data_type,
    options: optStmt.all(d.id) as FieldOptionDef[],
  }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/server/db/fields.test.ts`
Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/db/fields.ts src/server/db/fields.test.ts
git commit -m "Add beta-field and issue-type store (EAV model)"
```
(Append the Co-Authored-By trailer.)

---

### Task 7: Sync-state store

**Files:**
- Create: `src/server/db/syncState.ts`
- Test: `src/server/db/syncState.test.ts`

**Interfaces:**
- Consumes: `openDatabase` (Task 3), `upsertRepo` (Task 4).
- Produces, from `syncState.ts`:
  - `type SyncStatus = "idle" | "syncing" | "error"`
  - `interface SyncStateRow { repoId: string; lastSyncedAt: string | null; status: SyncStatus; error: string | null }`
  - `getSyncState(db, repoId: string): SyncStateRow | undefined`
  - `setSyncState(db, repoId: string, patch: Partial<Omit<SyncStateRow, "repoId">>): void` — upserts, leaving unspecified columns unchanged (or defaulting on first insert).
  - `listSyncStates(db): SyncStateRow[]`

- [ ] **Step 1: Write the failing test `src/server/db/syncState.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { openDatabase } from "./database.js";
import { upsertRepo } from "./repos.js";
import { getSyncState, setSyncState, listSyncStates } from "./syncState.js";

function seed(db: ReturnType<typeof openDatabase>) {
  upsertRepo(db, { id: "R_1", owner: "o", name: "n", isFork: false });
}

describe("sync-state store", () => {
  it("returns undefined before any state is set", () => {
    const db = openDatabase(":memory:");
    seed(db);
    expect(getSyncState(db, "R_1")).toBeUndefined();
  });

  it("creates state with defaults and updates a subset of fields", () => {
    const db = openDatabase(":memory:");
    seed(db);
    setSyncState(db, "R_1", { status: "syncing" });
    expect(getSyncState(db, "R_1")).toEqual({
      repoId: "R_1",
      lastSyncedAt: null,
      status: "syncing",
      error: null,
    });
    setSyncState(db, "R_1", { status: "idle", lastSyncedAt: "2026-01-02T00:00:00Z" });
    expect(getSyncState(db, "R_1")).toEqual({
      repoId: "R_1",
      lastSyncedAt: "2026-01-02T00:00:00Z",
      status: "idle",
      error: null,
    });
  });

  it("records an error", () => {
    const db = openDatabase(":memory:");
    seed(db);
    setSyncState(db, "R_1", { status: "error", error: "boom" });
    expect(getSyncState(db, "R_1")?.error).toBe("boom");
    expect(listSyncStates(db)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/server/db/syncState.test.ts`
Expected: FAIL — cannot find module `./syncState.js`.

- [ ] **Step 3: Write `src/server/db/syncState.ts`**

```ts
import type Database from "better-sqlite3";

export type SyncStatus = "idle" | "syncing" | "error";

export interface SyncStateRow {
  repoId: string;
  lastSyncedAt: string | null;
  status: SyncStatus;
  error: string | null;
}

interface RawSyncState {
  repo_id: string;
  last_synced_at: string | null;
  status: SyncStatus;
  error: string | null;
}

function toRow(r: RawSyncState): SyncStateRow {
  return {
    repoId: r.repo_id,
    lastSyncedAt: r.last_synced_at,
    status: r.status,
    error: r.error,
  };
}

export function getSyncState(
  db: Database.Database,
  repoId: string,
): SyncStateRow | undefined {
  const row = db.prepare("SELECT * FROM sync_state WHERE repo_id=?").get(repoId) as
    | RawSyncState
    | undefined;
  return row ? toRow(row) : undefined;
}

export function setSyncState(
  db: Database.Database,
  repoId: string,
  patch: Partial<Omit<SyncStateRow, "repoId">>,
): void {
  const existing = getSyncState(db, repoId);
  const next: SyncStateRow = {
    repoId,
    lastSyncedAt: patch.lastSyncedAt ?? existing?.lastSyncedAt ?? null,
    status: patch.status ?? existing?.status ?? "idle",
    error: patch.error !== undefined ? patch.error : (existing?.error ?? null),
  };
  db.prepare(
    `INSERT INTO sync_state (repo_id, last_synced_at, status, error)
     VALUES (@repo_id, @last_synced_at, @status, @error)
     ON CONFLICT(repo_id) DO UPDATE SET
       last_synced_at=@last_synced_at, status=@status, error=@error`,
  ).run({
    repo_id: next.repoId,
    last_synced_at: next.lastSyncedAt,
    status: next.status,
    error: next.error,
  });
}

export function listSyncStates(db: Database.Database): SyncStateRow[] {
  const rows = db.prepare("SELECT * FROM sync_state").all() as RawSyncState[];
  return rows.map(toRow);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/server/db/syncState.test.ts`
Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/db/syncState.ts src/server/db/syncState.test.ts
git commit -m "Add sync-state store"
```
(Append the Co-Authored-By trailer.)

---

### Task 8: GitHub GraphQL client

**Files:**
- Create: `src/server/github/types.ts`
- Create: `src/server/github/client.ts`
- Test: `src/server/github/client.test.ts`

**Interfaces:**
- Consumes: `FieldDataType` (Task 6) — re-declare the union locally in `types.ts` to avoid a DB dependency; keep the string values identical (`"single_select" | "multi_select" | "number" | "text" | "date"`).
- Produces, from `client.ts`/`types.ts`:
  - `type GraphQLRequest = <T = unknown>(query: string, variables?: Record<string, unknown>) => Promise<T>`
  - `interface RepoInfo { id: string; owner: string; name: string; isFork: boolean }`
  - `interface FetchedFieldValue { fieldName: string; dataType: FieldDataType; valueText?: string; valueNumber?: number; valueDate?: string; optionId?: string }`
  - `interface FetchedIssue { id: string; number: number; title: string; isPullRequest: boolean; state: string; author: string | null; assignees: string[]; labels: string[]; milestone: string | null; createdAt: string; updatedAt: string; comments: number; issueType: { id: string; name: string } | null; fieldValues: FetchedFieldValue[] }`
  - `interface GitHubClient { listOrgRepos(org: string): Promise<RepoInfo[]>; listUserRepos(username: string): Promise<RepoInfo[]>; fetchIssuesUpdatedSince(owner: string, name: string, since: string | null): Promise<FetchedIssue[]>; discoverIssueTypes(owner: string, name: string): Promise<Array<{ id: string; name: string; color: string | null; description: string | null }>>; discoverFields(owner: string, name: string): Promise<Array<{ id: string; name: string; dataType: FieldDataType; options: Array<{ id: string; name: string; color: string | null; position: number | null }> }>> }`
  - `createGitHubClient(request: GraphQLRequest): GitHubClient`
  - `createDefaultRequest(token: string): GraphQLRequest` — wraps `@octokit/graphql` with the auth header.

**Implementation notes:**
- `fetchIssuesUpdatedSince` queries the `issues` connection ordered by `UPDATED_AT DESC`, paginating with `after` and stopping once a node's `updatedAt <= since` (when `since` is non-null), then queries the `pullRequests` connection the same way (PRs have no issueType/fieldValues). It returns issues and PRs combined; PRs always have `issueType: null` and `fieldValues: []`.
- Field values use **per-fragment aliases** to avoid GraphQL response-key type collisions, following the `github-issue-fields` skill. The mapping: single-select -> `{ dataType: "single_select", valueText: ssValue, optionId }`; multi-select -> one `FetchedFieldValue` per selected value `{ dataType: "multi_select", valueText: each }`; number -> `{ dataType: "number", valueNumber }`; text -> `{ dataType: "text", valueText }`; date -> `{ dataType: "date", valueDate }`.
- Verify the exact field-value selection against the live API during implementation; correct the aliases/paths if GitHub's schema differs.

- [ ] **Step 1: Write the failing test `src/server/github/client.test.ts`**

The test injects a fake `GraphQLRequest` that dispatches on a marker substring in the query and returns canned payloads, asserting the client normalizes them and paginates.

```ts
import { describe, it, expect, vi } from "vitest";
import { createGitHubClient, type GraphQLRequest } from "./client.js";

describe("GitHubClient", () => {
  it("lists org repos across pages", async () => {
    const pages = [
      {
        organization: {
          repositories: {
            nodes: [{ id: "R_1", name: "a", isFork: false, owner: { login: "org" } }],
            pageInfo: { hasNextPage: true, endCursor: "c1" },
          },
        },
      },
      {
        organization: {
          repositories: {
            nodes: [{ id: "R_2", name: "b", isFork: true, owner: { login: "org" } }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ];
    const request = vi.fn(async (_q: string, vars?: any) =>
      vars?.cursor == null ? pages[0] : pages[1],
    ) as unknown as GraphQLRequest;

    const client = createGitHubClient(request);
    const repos = await client.listOrgRepos("org");
    expect(repos).toEqual([
      { id: "R_1", owner: "org", name: "a", isFork: false },
      { id: "R_2", owner: "org", name: "b", isFork: true },
    ]);
  });

  it("normalizes issues with type and field values and stops at `since`", async () => {
    const issuesPayload = {
      repository: {
        issues: {
          nodes: [
            {
              id: "I_2",
              number: 2,
              title: "new",
              state: "OPEN",
              createdAt: "2026-01-03T00:00:00Z",
              updatedAt: "2026-01-03T00:00:00Z",
              author: { login: "alice" },
              assignees: { nodes: [{ login: "bob" }] },
              labels: { nodes: [{ name: "bug" }] },
              milestone: { title: "v1" },
              comments: { totalCount: 2 },
              issueType: { id: "IT_1", name: "Bug" },
              issueFieldValues: {
                nodes: [
                  {
                    __typename: "IssueFieldSingleSelectValue",
                    ssValue: "High",
                    optionId: "IFSSO_1",
                    field: { name: "Priority" },
                  },
                ],
              },
            },
            {
              id: "I_1",
              number: 1,
              title: "old",
              state: "OPEN",
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
              author: { login: "alice" },
              assignees: { nodes: [] },
              labels: { nodes: [] },
              milestone: null,
              comments: { totalCount: 0 },
              issueType: null,
              issueFieldValues: { nodes: [] },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    };
    const prPayload = {
      repository: {
        pullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      },
    };
    const request = vi.fn(async (q: string) =>
      q.includes("pullRequests") ? prPayload : issuesPayload,
    ) as unknown as GraphQLRequest;

    const client = createGitHubClient(request);
    const issues = await client.fetchIssuesUpdatedSince("o", "n", "2026-01-02T00:00:00Z");

    expect(issues.map((i) => i.id)).toEqual(["I_2"]); // I_1 is at/under `since`
    expect(issues[0].issueType).toEqual({ id: "IT_1", name: "Bug" });
    expect(issues[0].fieldValues).toEqual([
      { fieldName: "Priority", dataType: "single_select", valueText: "High", optionId: "IFSSO_1" },
    ]);
    expect(issues[0].labels).toEqual(["bug"]);
    expect(issues[0].assignees).toEqual(["bob"]);
  });

  it("discovers fields with options", async () => {
    const payload = {
      repository: {
        issueFields: {
          nodes: [
            {
              __typename: "IssueFieldSingleSelect",
              id: "IFSS_1",
              name: "Priority",
              dataType: "SINGLE_SELECT",
              options: [{ id: "IFSSO_1", name: "High", color: "RED", description: null }],
            },
            { __typename: "IssueFieldNumber", id: "IFN_1", name: "Effort", dataType: "NUMBER" },
          ],
        },
      },
    };
    const request = vi.fn(async () => payload) as unknown as GraphQLRequest;
    const client = createGitHubClient(request);
    const fields = await client.discoverFields("o", "n");
    expect(fields).toEqual([
      {
        id: "IFSS_1",
        name: "Priority",
        dataType: "single_select",
        options: [{ id: "IFSSO_1", name: "High", color: "RED", position: 0 }],
      },
      { id: "IFN_1", name: "Effort", dataType: "number", options: [] },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/server/github/client.test.ts`
Expected: FAIL — cannot find module `./client.js`.

- [ ] **Step 3: Write `src/server/github/types.ts`**

```ts
export type FieldDataType =
  | "single_select"
  | "multi_select"
  | "number"
  | "text"
  | "date";

export interface RepoInfo {
  id: string;
  owner: string;
  name: string;
  isFork: boolean;
}

export interface FetchedFieldValue {
  fieldName: string;
  dataType: FieldDataType;
  valueText?: string;
  valueNumber?: number;
  valueDate?: string;
  optionId?: string;
}

export interface FetchedIssue {
  id: string;
  number: number;
  title: string;
  isPullRequest: boolean;
  state: string;
  author: string | null;
  assignees: string[];
  labels: string[];
  milestone: string | null;
  createdAt: string;
  updatedAt: string;
  comments: number;
  issueType: { id: string; name: string } | null;
  fieldValues: FetchedFieldValue[];
}

const TYPE_MAP: Record<string, FieldDataType> = {
  SINGLE_SELECT: "single_select",
  MULTI_SELECT: "multi_select",
  NUMBER: "number",
  TEXT: "text",
  DATE: "date",
};

export function normalizeDataType(apiType: string): FieldDataType {
  const t = TYPE_MAP[apiType];
  if (!t) throw new Error(`Unknown field data type: ${apiType}`);
  return t;
}
```

- [ ] **Step 4: Write `src/server/github/client.ts`**

```ts
import { graphql } from "@octokit/graphql";
import {
  normalizeDataType,
  type FetchedFieldValue,
  type FetchedIssue,
  type FieldDataType,
  type RepoInfo,
} from "./types.js";

export type GraphQLRequest = <T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
) => Promise<T>;

export interface IssueTypeDiscovery {
  id: string;
  name: string;
  color: string | null;
  description: string | null;
}

export interface FieldDiscovery {
  id: string;
  name: string;
  dataType: FieldDataType;
  options: Array<{ id: string; name: string; color: string | null; position: number | null }>;
}

export interface GitHubClient {
  listOrgRepos(org: string): Promise<RepoInfo[]>;
  listUserRepos(username: string): Promise<RepoInfo[]>;
  fetchIssuesUpdatedSince(
    owner: string,
    name: string,
    since: string | null,
  ): Promise<FetchedIssue[]>;
  discoverIssueTypes(owner: string, name: string): Promise<IssueTypeDiscovery[]>;
  discoverFields(owner: string, name: string): Promise<FieldDiscovery[]>;
}

export function createDefaultRequest(token: string): GraphQLRequest {
  const authed = graphql.defaults({ headers: { authorization: `token ${token}` } });
  return ((query, variables) => authed(query, variables)) as GraphQLRequest;
}

const REPO_FIELDS = `nodes { id name isFork owner { login } } pageInfo { hasNextPage endCursor }`;

const ISSUE_NODE = `
  id number title state createdAt updatedAt
  author { login }
  assignees(first: 20) { nodes { login } }
  labels(first: 50) { nodes { name } }
  milestone { title }
  comments { totalCount }
  issueType { id name }
  issueFieldValues(first: 50) {
    nodes {
      __typename
      ... on IssueFieldSingleSelectValue { ssValue: value optionId field { ... on IssueFieldSingleSelect { name } } }
      ... on IssueFieldMultiSelectValue  { msValues: value field { ... on IssueFieldMultiSelect { name } } }
      ... on IssueFieldNumberValue       { numValue: value field { ... on IssueFieldNumber { name } } }
      ... on IssueFieldTextValue         { txtValue: value field { ... on IssueFieldText { name } } }
      ... on IssueFieldDateValue         { dateValue: value field { ... on IssueFieldDate { name } } }
    }
  }`;

const PR_NODE = `id number title state createdAt updatedAt
  author { login }
  assignees(first: 20) { nodes { login } }
  labels(first: 50) { nodes { name } }
  milestone { title }
  comments { totalCount }`;

interface Page<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

function mapRepo(n: { id: string; name: string; isFork: boolean; owner: { login: string } }): RepoInfo {
  return { id: n.id, owner: n.owner.login, name: n.name, isFork: n.isFork };
}

function mapFieldValues(nodes: any[]): FetchedFieldValue[] {
  const out: FetchedFieldValue[] = [];
  for (const n of nodes ?? []) {
    const fieldName = n.field?.name as string | undefined;
    if (!fieldName) continue;
    switch (n.__typename) {
      case "IssueFieldSingleSelectValue":
        out.push({ fieldName, dataType: "single_select", valueText: n.ssValue, optionId: n.optionId });
        break;
      case "IssueFieldMultiSelectValue":
        for (const v of n.msValues ?? []) {
          out.push({ fieldName, dataType: "multi_select", valueText: v });
        }
        break;
      case "IssueFieldNumberValue":
        out.push({ fieldName, dataType: "number", valueNumber: n.numValue });
        break;
      case "IssueFieldTextValue":
        out.push({ fieldName, dataType: "text", valueText: n.txtValue });
        break;
      case "IssueFieldDateValue":
        out.push({ fieldName, dataType: "date", valueDate: n.dateValue });
        break;
    }
  }
  return out;
}

function mapIssue(n: any, isPullRequest: boolean): FetchedIssue {
  return {
    id: n.id,
    number: n.number,
    title: n.title,
    isPullRequest,
    state: n.state,
    author: n.author?.login ?? null,
    assignees: (n.assignees?.nodes ?? []).map((a: any) => a.login),
    labels: (n.labels?.nodes ?? []).map((l: any) => l.name),
    milestone: n.milestone?.title ?? null,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    comments: n.comments?.totalCount ?? 0,
    issueType: n.issueType ? { id: n.issueType.id, name: n.issueType.name } : null,
    fieldValues: isPullRequest ? [] : mapFieldValues(n.issueFieldValues?.nodes ?? []),
  };
}

export function createGitHubClient(request: GraphQLRequest): GitHubClient {
  async function pageRepos(
    root: "organization" | "user",
    loginKey: "org" | "login",
    login: string,
  ): Promise<RepoInfo[]> {
    const out: RepoInfo[] = [];
    let cursor: string | null = null;
    const query = `query($login:String!, $cursor:String){
      ${root}(login:$login){
        repositories(first:100, after:$cursor, ownerAffiliations:[OWNER]){ ${REPO_FIELDS} }
      }
    }`;
    do {
      const data = await request<any>(query, { login, cursor });
      const conn: Page<any> = data[root].repositories;
      out.push(...conn.nodes.map(mapRepo));
      cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    } while (cursor);
    return out;
  }

  async function pageIssues(
    owner: string,
    name: string,
    since: string | null,
    connection: "issues" | "pullRequests",
  ): Promise<FetchedIssue[]> {
    const out: FetchedIssue[] = [];
    let cursor: string | null = null;
    const nodeBody = connection === "issues" ? ISSUE_NODE : PR_NODE;
    const query = `query($owner:String!, $name:String!, $cursor:String){
      repository(owner:$owner, name:$name){
        ${connection}(first:50, after:$cursor, orderBy:{field:UPDATED_AT, direction:DESC}){
          nodes { ${nodeBody} }
          pageInfo { hasNextPage endCursor }
        }
      }
    }`;
    outer: do {
      const data = await request<any>(query, { owner, name, cursor });
      const conn: Page<any> = data.repository[connection];
      for (const node of conn.nodes) {
        if (since && node.updatedAt <= since) break outer;
        out.push(mapIssue(node, connection === "pullRequests"));
      }
      cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    } while (cursor);
    return out;
  }

  return {
    listOrgRepos: (org) => pageRepos("organization", "org", org),
    listUserRepos: (username) => pageRepos("user", "login", username),

    async fetchIssuesUpdatedSince(owner, name, since) {
      const issues = await pageIssues(owner, name, since, "issues");
      const prs = await pageIssues(owner, name, since, "pullRequests");
      return [...issues, ...prs];
    },

    async discoverIssueTypes(owner, name) {
      const data = await request<any>(
        `query($owner:String!,$name:String!){
          repository(owner:$owner,name:$name){
            issueTypes(first:50){ nodes { id name color description } }
          }
        }`,
        { owner, name },
      );
      return (data.repository.issueTypes?.nodes ?? []).map((t: any) => ({
        id: t.id,
        name: t.name,
        color: t.color ?? null,
        description: t.description ?? null,
      }));
    },

    async discoverFields(owner, name) {
      const data = await request<any>(
        `query($owner:String!,$name:String!){
          repository(owner:$owner,name:$name){
            issueFields(first:50){
              nodes{
                __typename
                ... on IssueFieldSingleSelect { id name dataType options { id name color description } }
                ... on IssueFieldMultiSelect  { id name dataType options { id name color } }
                ... on IssueFieldNumber { id name dataType }
                ... on IssueFieldText   { id name dataType }
                ... on IssueFieldDate   { id name dataType }
              }
            }
          }
        }`,
        { owner, name },
      );
      return (data.repository.issueFields?.nodes ?? []).map((f: any) => ({
        id: f.id,
        name: f.name,
        dataType: normalizeDataType(f.dataType),
        options: (f.options ?? []).map((o: any, i: number) => ({
          id: o.id,
          name: o.name,
          color: o.color ?? null,
          position: i,
        })),
      }));
    },
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/server/github/client.test.ts`
Expected: all 3 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/github/types.ts src/server/github/client.ts src/server/github/client.test.ts
git commit -m "Add GitHub GraphQL client for discovery and issue fetch"
```
(Append the Co-Authored-By trailer.)

---

### Task 9: Repo resolver

**Files:**
- Create: `src/server/resolver/repoResolver.ts`
- Test: `src/server/resolver/repoResolver.test.ts`

**Interfaces:**
- Consumes: `Config`/`Tab`/`MatchRule` (Task 2), `GitHubClient`/`RepoInfo` (Task 8).
- Produces, from `repoResolver.ts`:
  - `interface ResolvedTab { name: string; repos: RepoInfo[]; tab: Tab }`
  - `resolveRepos(config: Config, client: Pick<GitHubClient, "listOrgRepos" | "listUserRepos">): Promise<{ tabs: ResolvedTab[]; allRepos: RepoInfo[] }>`
  - Behavior:
    - Each tab's repo set is the **union** of its match rules.
    - Org rule -> `listOrgRepos`. Explicit `repos` -> resolve each `owner/name` against the union of all discovered repos (org repos + the user's repos); entries that cannot be resolved to a known `RepoInfo` are skipped (a later phase may fetch them directly, out of scope here).
    - Catch-all -> the user's own repos (`listUserRepos(config.username)`) minus any repo claimed by **any other tab's non-catch-all rules**.
    - **Forks are excluded** everywhere unless the repo's `owner/name` is in `config.forkAllowlist`.
    - A catch-all tab that resolves to zero repos is **omitted** from `tabs`.
    - `allRepos` is the deduplicated union across all resolved tabs (dedup by repo `id`).
  - Caching: call `listOrgRepos` once per distinct org and `listUserRepos` once; reuse results.

- [ ] **Step 1: Write the failing test `src/server/resolver/repoResolver.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { resolveRepos } from "./repoResolver.js";
import type { RepoInfo } from "../github/types.js";
import type { Config } from "../config/schema.js";

function client(data: { orgs?: Record<string, RepoInfo[]>; user?: RepoInfo[] }) {
  return {
    listOrgRepos: async (org: string) => data.orgs?.[org] ?? [],
    listUserRepos: async () => data.user ?? [],
  };
}

const cfg = (over: Partial<Config>): Config => ({
  username: "octocat",
  ttlMinutes: 10,
  bindAddress: "127.0.0.1",
  port: 8080,
  forkAllowlist: [],
  tabs: [],
  ...over,
});

describe("resolveRepos", () => {
  it("expands an org and excludes forks unless allowlisted", async () => {
    const c = cfg({
      forkAllowlist: ["org/keptfork"],
      tabs: [{ name: "Org", match: [{ org: "org" }] }],
    });
    const repos = await resolveRepos(
      c,
      client({
        orgs: {
          org: [
            { id: "R_1", owner: "org", name: "lib", isFork: false },
            { id: "R_2", owner: "org", name: "droppedfork", isFork: true },
            { id: "R_3", owner: "org", name: "keptfork", isFork: true },
          ],
        },
      }),
    );
    expect(repos.tabs[0].repos.map((r) => r.name).sort()).toEqual(["keptfork", "lib"]);
  });

  it("unions mixed rules within one tab", async () => {
    const c = cfg({
      tabs: [
        {
          name: "Mixed",
          match: [{ org: "org1" }, { repos: ["org2/foo"] }],
        },
      ],
    });
    const repos = await resolveRepos(
      c,
      client({
        orgs: {
          org1: [{ id: "R_1", owner: "org1", name: "a", isFork: false }],
          org2: [
            { id: "R_2", owner: "org2", name: "foo", isFork: false },
            { id: "R_3", owner: "org2", name: "bar", isFork: false },
          ],
        },
        user: [],
      }),
    );
    expect(repos.tabs[0].repos.map((r) => r.id).sort()).toEqual(["R_1", "R_2"]);
  });

  it("computes catch-all as user repos not claimed by other tabs", async () => {
    const c = cfg({
      tabs: [
        { name: "Org", match: [{ org: "org" }] },
        { name: "Personal", match: [{ catchAll: true }] },
      ],
    });
    const repos = await resolveRepos(
      c,
      client({
        orgs: { org: [{ id: "R_1", owner: "org", name: "lib", isFork: false }] },
        user: [
          { id: "R_2", owner: "octocat", name: "dotfiles", isFork: false },
          { id: "R_1", owner: "org", name: "lib", isFork: false },
        ],
      }),
    );
    const personal = repos.tabs.find((t) => t.name === "Personal")!;
    expect(personal.repos.map((r) => r.id)).toEqual(["R_2"]);
  });

  it("omits an empty catch-all tab", async () => {
    const c = cfg({
      tabs: [
        { name: "Org", match: [{ org: "org" }] },
        { name: "Personal", match: [{ catchAll: true }] },
      ],
    });
    const repos = await resolveRepos(
      c,
      client({
        orgs: { org: [{ id: "R_1", owner: "org", name: "lib", isFork: false }] },
        user: [{ id: "R_1", owner: "org", name: "lib", isFork: false }],
      }),
    );
    expect(repos.tabs.map((t) => t.name)).toEqual(["Org"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/server/resolver/repoResolver.test.ts`
Expected: FAIL — cannot find module `./repoResolver.js`.

- [ ] **Step 3: Write `src/server/resolver/repoResolver.ts`**

```ts
import type { Config, Tab } from "../config/schema.js";
import type { GitHubClient } from "../github/client.js";
import type { RepoInfo } from "../github/types.js";

export interface ResolvedTab {
  name: string;
  repos: RepoInfo[];
  tab: Tab;
}

type Discovery = Pick<GitHubClient, "listOrgRepos" | "listUserRepos">;

function key(owner: string, name: string): string {
  return `${owner}/${name}`.toLowerCase();
}

export async function resolveRepos(
  config: Config,
  client: Discovery,
): Promise<{ tabs: ResolvedTab[]; allRepos: RepoInfo[] }> {
  const allow = new Set(config.forkAllowlist.map((r) => r.toLowerCase()));
  const orgCache = new Map<string, RepoInfo[]>();
  let userRepos: RepoInfo[] | null = null;

  const getOrg = async (org: string): Promise<RepoInfo[]> => {
    if (!orgCache.has(org)) orgCache.set(org, await client.listOrgRepos(org));
    return orgCache.get(org)!;
  };
  const getUser = async (): Promise<RepoInfo[]> => {
    if (userRepos === null) userRepos = await client.listUserRepos(config.username);
    return userRepos;
  };

  const keep = (r: RepoInfo): boolean => !r.isFork || allow.has(key(r.owner, r.name));

  // First pass: resolve every non-catch-all rule, tracking which repos are "claimed".
  const claimed = new Set<string>();
  const knownByKey = new Map<string, RepoInfo>();
  const register = (r: RepoInfo) => knownByKey.set(key(r.owner, r.name), r);

  const explicitTabRepos: RepoInfo[][] = [];
  for (const tab of config.tabs) {
    const set = new Map<string, RepoInfo>();
    for (const rule of tab.match) {
      if ("org" in rule) {
        for (const r of await getOrg(rule.org)) {
          register(r);
          if (keep(r)) {
            set.set(r.id, r);
            claimed.add(key(r.owner, r.name));
          }
        }
      } else if ("repos" in rule) {
        for (const spec of rule.repos) claimed.add(spec.toLowerCase());
      }
    }
    explicitTabRepos.push([...set.values()]);
  }

  // Make user repos available for explicit-spec resolution and catch-all.
  for (const r of await getUser()) register(r);

  // Second pass: finalize each tab (resolve explicit specs, compute catch-all).
  const tabs: ResolvedTab[] = [];
  config.tabs.forEach((tab, idx) => {
    const set = new Map<string, RepoInfo>();
    for (const r of explicitTabRepos[idx]) set.set(r.id, r);

    for (const rule of tab.match) {
      if ("repos" in rule) {
        for (const spec of rule.repos) {
          const r = knownByKey.get(spec.toLowerCase());
          if (r && keep(r)) set.set(r.id, r);
        }
      } else if ("catchAll" in rule) {
        for (const r of userRepos!) {
          if (!keep(r)) continue;
          if (claimed.has(key(r.owner, r.name))) continue;
          set.set(r.id, r);
        }
      }
    }

    const repos = [...set.values()];
    const isCatchAll = tab.match.some((m) => "catchAll" in m);
    if (isCatchAll && repos.length === 0) return; // omit empty catch-all
    tabs.push({ name: tab.name, repos, tab });
  });

  const all = new Map<string, RepoInfo>();
  for (const t of tabs) for (const r of t.repos) all.set(r.id, r);

  return { tabs, allRepos: [...all.values()] };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/server/resolver/repoResolver.test.ts`
Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/resolver/repoResolver.ts src/server/resolver/repoResolver.test.ts
git commit -m "Add repo resolver with union rules and catch-all"
```
(Append the Co-Authored-By trailer.)

---

### Task 10: Sync engine and CLI

**Files:**
- Create: `src/server/sync/engine.ts`
- Create: `src/server/cli.ts`
- Test: `src/server/sync/engine.test.ts`

**Interfaces:**
- Consumes: every store (Tasks 3-7), `GitHubClient`/`FetchedIssue` (Task 8), `RepoInfo` (Task 8), `resolveRepos` (Task 9), `loadConfig` (Task 2), `openDatabase` (Task 3).
- Produces, from `engine.ts`:
  - `isStale(state: SyncStateRow | undefined, ttlMinutes: number, now: Date): boolean` — true when never synced or `lastSyncedAt` older than `ttlMinutes` before `now`.
  - `syncRepo(db, client: GitHubClient, repo: RepoInfo, opts?: { now?: Date }): Promise<void>` — incremental: discovers types/fields, fetches issues updated since `lastSyncedAt`, upserts open items (with field values + type), **deletes** items whose fetched `state` is not `OPEN`, updates `sync_state` (status + `lastSyncedAt`), and records errors.
  - `syncStaleRepos(db, client, repos: RepoInfo[], ttlMinutes: number, opts?: { force?: boolean; now?: Date }): Promise<void>` — processes repos **serially**; skips fresh repos unless `force`.
- `cli.ts` loads config, opens the DB (`SELEYA_DB` env or `seleya.db`), resolves repos, upserts them, and runs `syncStaleRepos(..., { force: true })`, printing a one-line summary per repo.

**Implementation notes:**
- "Delete items whose state is not OPEN": the incremental fetch is ordered by `updatedAt` and includes items that just closed (their `state` will be `CLOSED`/`MERGED`). For each fetched item, if `state === "OPEN"` upsert it; otherwise delete it by id (a no-op if absent).
- On a per-repo error, set `sync_state` status `error` with the message and continue to the next repo (do not throw out of `syncStaleRepos`).
- Field definitions discovered for the repo are stored via `upsertFieldDefinition`; issue types via `upsertIssueType`. An issue's own type (from the issue payload) is written through `upsertIssueType` too before the issue row references it, to satisfy display needs (the `issues` row stores `issue_type_id`/`issue_type_name` directly, so no FK is enforced, but storing the definition keeps colors available).

- [ ] **Step 1: Write the failing test `src/server/sync/engine.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";
import { openDatabase } from "../db/database.js";
import { upsertRepo } from "../db/repos.js";
import { getIssue } from "../db/issues.js";
import { getSyncState } from "../db/syncState.js";
import { getFieldValues } from "../db/fields.js";
import { isStale, syncRepo, syncStaleRepos } from "./engine.js";
import type { GitHubClient } from "../github/client.js";
import type { FetchedIssue, RepoInfo } from "../github/types.js";

const repo: RepoInfo = { id: "R_1", owner: "o", name: "n", isFork: false };

function fakeClient(over: Partial<GitHubClient>): GitHubClient {
  return {
    listOrgRepos: async () => [],
    listUserRepos: async () => [],
    fetchIssuesUpdatedSince: async () => [],
    discoverIssueTypes: async () => [],
    discoverFields: async () => [],
    ...over,
  };
}

const openIssue: FetchedIssue = {
  id: "I_1", number: 1, title: "open", isPullRequest: false, state: "OPEN",
  author: "a", assignees: [], labels: ["bug"], milestone: null,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z",
  comments: 0, issueType: { id: "IT_1", name: "Bug" },
  fieldValues: [{ fieldName: "Priority", dataType: "single_select", valueText: "High", optionId: "IFSSO_1" }],
};

describe("isStale", () => {
  const now = new Date("2026-01-01T01:00:00Z");
  it("is stale when never synced", () => {
    expect(isStale(undefined, 10, now)).toBe(true);
  });
  it("is stale when older than the TTL", () => {
    expect(isStale({ repoId: "R_1", lastSyncedAt: "2026-01-01T00:40:00Z", status: "idle", error: null }, 10, now)).toBe(true);
  });
  it("is fresh within the TTL", () => {
    expect(isStale({ repoId: "R_1", lastSyncedAt: "2026-01-01T00:55:00Z", status: "idle", error: null }, 10, now)).toBe(false);
  });
});

describe("syncRepo", () => {
  it("upserts an open issue with field values and marks the repo synced", async () => {
    const db = openDatabase(":memory:");
    upsertRepo(db, repo);
    const client = fakeClient({ fetchIssuesUpdatedSince: async () => [openIssue] });
    await syncRepo(db, client, repo, { now: new Date("2026-01-02T01:00:00Z") });

    expect(getIssue(db, "I_1")?.title).toBe("open");
    expect(getFieldValues(db, "I_1")[0].valueText).toBe("High");
    const state = getSyncState(db, "R_1");
    expect(state?.status).toBe("idle");
    expect(state?.lastSyncedAt).toBe("2026-01-02T01:00:00.000Z");
  });

  it("removes an issue that is no longer open", async () => {
    const db = openDatabase(":memory:");
    upsertRepo(db, repo);
    await syncRepo(db, fakeClient({ fetchIssuesUpdatedSince: async () => [openIssue] }), repo);
    await syncRepo(
      db,
      fakeClient({ fetchIssuesUpdatedSince: async () => [{ ...openIssue, state: "CLOSED" }] }),
      repo,
    );
    expect(getIssue(db, "I_1")).toBeUndefined();
  });

  it("records an error and does not throw", async () => {
    const db = openDatabase(":memory:");
    upsertRepo(db, repo);
    const client = fakeClient({
      fetchIssuesUpdatedSince: async () => {
        throw new Error("rate limited");
      },
    });
    await syncRepo(db, client, repo);
    const state = getSyncState(db, "R_1");
    expect(state?.status).toBe("error");
    expect(state?.error).toMatch(/rate limited/);
  });
});

describe("syncStaleRepos", () => {
  it("skips fresh repos unless forced", async () => {
    const db = openDatabase(":memory:");
    upsertRepo(db, repo);
    const fetch = vi.fn(async () => [] as FetchedIssue[]);
    const client = fakeClient({ fetchIssuesUpdatedSince: fetch });
    await syncStaleRepos(db, client, [repo], 10, { now: new Date("2026-01-02T00:00:00Z") });
    expect(fetch).toHaveBeenCalledTimes(1); // first sync (was stale)
    await syncStaleRepos(db, client, [repo], 10, { now: new Date("2026-01-02T00:01:00Z") });
    expect(fetch).toHaveBeenCalledTimes(1); // still fresh -> skipped
    await syncStaleRepos(db, client, [repo], 10, { force: true, now: new Date("2026-01-02T00:01:00Z") });
    expect(fetch).toHaveBeenCalledTimes(2); // forced
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/server/sync/engine.test.ts`
Expected: FAIL — cannot find module `./engine.js`.

- [ ] **Step 3: Write `src/server/sync/engine.ts`**

```ts
import type Database from "better-sqlite3";
import type { GitHubClient } from "../github/client.js";
import type { FetchedIssue, RepoInfo } from "../github/types.js";
import { upsertIssue, deleteIssue, type IssueRecord } from "../db/issues.js";
import {
  upsertFieldDefinition,
  upsertIssueType,
  setIssueFieldValues,
  type IssueFieldValue,
} from "../db/fields.js";
import { getSyncState, setSyncState, type SyncStateRow } from "../db/syncState.js";

export function isStale(
  state: SyncStateRow | undefined,
  ttlMinutes: number,
  now: Date,
): boolean {
  if (!state?.lastSyncedAt) return true;
  const age = now.getTime() - new Date(state.lastSyncedAt).getTime();
  return age >= ttlMinutes * 60_000;
}

function toRecord(repoId: string, f: FetchedIssue): IssueRecord {
  return {
    id: f.id,
    repoId,
    number: f.number,
    title: f.title,
    isPullRequest: f.isPullRequest,
    state: f.state,
    author: f.author,
    assignees: f.assignees,
    labels: f.labels,
    milestone: f.milestone,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
    comments: f.comments,
    issueTypeId: f.issueType?.id ?? null,
    issueTypeName: f.issueType?.name ?? null,
  };
}

export async function syncRepo(
  db: Database.Database,
  client: GitHubClient,
  repo: RepoInfo,
  opts?: { now?: Date },
): Promise<void> {
  const now = opts?.now ?? new Date();
  setSyncState(db, repo.id, { status: "syncing", error: null });
  try {
    for (const t of await client.discoverIssueTypes(repo.owner, repo.name)) {
      upsertIssueType(db, t);
    }
    for (const f of await client.discoverFields(repo.owner, repo.name)) {
      upsertFieldDefinition(db, { ...f, repoId: repo.id });
    }

    const since = getSyncState(db, repo.id)?.lastSyncedAt ?? null;
    const fetched = await client.fetchIssuesUpdatedSince(repo.owner, repo.name, since);

    for (const f of fetched) {
      if (f.state === "OPEN") {
        if (f.issueType) {
          upsertIssueType(db, {
            id: f.issueType.id,
            name: f.issueType.name,
            color: null,
            description: null,
          });
        }
        upsertIssue(db, toRecord(repo.id, f));
        setIssueFieldValues(db, f.id, f.fieldValues as IssueFieldValue[]);
      } else {
        deleteIssue(db, f.id);
      }
    }

    setSyncState(db, repo.id, {
      status: "idle",
      error: null,
      lastSyncedAt: now.toISOString(),
    });
  } catch (err) {
    setSyncState(db, repo.id, {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function syncStaleRepos(
  db: Database.Database,
  client: GitHubClient,
  repos: RepoInfo[],
  ttlMinutes: number,
  opts?: { force?: boolean; now?: Date },
): Promise<void> {
  const now = opts?.now ?? new Date();
  for (const repo of repos) {
    if (!opts?.force && !isStale(getSyncState(db, repo.id), ttlMinutes, now)) continue;
    await syncRepo(db, client, repo, { now });
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/server/sync/engine.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Write `src/server/cli.ts`**

```ts
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
```

- [ ] **Step 6: Verify the build and full test suite pass**

Run: `npm run typecheck`
Expected: no type errors.
Run: `npm test`
Expected: all suites PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server/sync/engine.ts src/server/sync/engine.test.ts src/server/cli.ts
git commit -m "Add sync engine and seleya sync CLI"
```
(Append the Co-Authored-By trailer.)

---

## Manual verification (end of Plan 1)

After Task 10, do a real-world smoke test (requires a PAT with the scopes from the spec):

1. `cp config.example.yaml config.yaml` and edit it for one small org or a couple of repos you own.
2. `export GITHUB_TOKEN=...`
3. `npm run sync`
4. Confirm the per-repo summary prints `idle` for each repo and `seleya.db` is created.
5. Inspect with `sqlite3 seleya.db "SELECT COUNT(*) FROM issues;"` and `... "SELECT field_name, value_text FROM issue_field_values LIMIT 5;"` to confirm issues and any beta-field values landed.
6. Confirm `config.yaml` and `seleya.db` are gitignored (`git status` shows them untracked/ignored).

This proves the ingestion path end-to-end and validates the GraphQL field-value selection against the live API before Plan 2 builds the read/serve layer on top.

## Self-Review notes (coverage against the spec)

- Config file as source of truth, PAT from env, secrets/DB gitignored: Tasks 1-2.
- SQLite source of truth, name-keyed EAV for beta fields: Tasks 3-7.
- GraphQL client incl. Types/Fields, no project scope: Task 8.
- Tab membership (org / explicit / catch-all, union, overlap, fork allowlist, hide empty catch-all): Task 9.
- Incremental sync, closed-item removal, per-repo state/errors, serial processing, TTL staleness: Task 10.
- Deferred to Plan 2 (intentionally): query/filter-to-SQL engine, HTTP API, refresh behavior (TTL-on-open, "reload when ready", "refresh now"), deep-refresh reconciliation of deletions/transfers, React/Mantine UI, README/AGENTS/NOTICE, post-sync config typo warnings, rate-limit budget surfacing.
