# Seleya

Seleya is a self-hosted dashboard that gathers open issues and pull requests
from many GitHub repositories and organizations into one web view, organized
into tabs and configurable groups. It is named after the tallest mountain on
Vulcan: a high vantage point from which to see far across your projects.

It reads private repositories through a Personal Access Token, surfaces GitHub's
newer beta issue features (issue Types and custom Fields such as Priority and
Effort) that the normal REST API does not expose, caches everything locally in
SQLite, and refreshes on demand.

## Security: please read this first

Seleya has **no built-in authentication**. By default it binds to `127.0.0.1`
(localhost) only.

If you run it against private repositories, you are responsible for gating
access at the network or deployment layer (localhost only, a VPN such as
Tailscale, a reverse proxy with authentication, a firewall, or an SSH tunnel).
Do not expose Seleya to an untrusted network. The Personal Access Token and the
local SQLite database both grant access to your private data.

The token is never stored in the config file. It is read from the environment.
The database file and any secrets file are gitignored.

## Quick start

Requirements: Node.js 20.19+ or 22.12+ (per Vite 8).

```bash
npm install
cp config.example.yaml config.yaml   # then edit config.yaml for your orgs/repos
export GITHUB_TOKEN=$(gh auth token)  # or export a PAT directly
npm run build                          # builds the server and the web client
npm run start                          # serves http://127.0.0.1:<port>
```

Open the printed URL in a browser. Opening the dashboard triggers a background
refresh when the local data is stale (or empty); the page shows cached data
immediately and a "reload when ready" option refreshes it once the sync
finishes.

To populate or refresh the database from the command line without the web UI:

```bash
GITHUB_TOKEN=$(gh auth token) npm run sync
```

## Personal Access Token scopes

Issue Types and custom Fields live on the issue itself (not Projects v2), so no
`project` or `read:project` scope is required.

Classic token:

- Public repositories only: `public_repo` and `read:org`.
- Including private repositories: `repo` and `read:org`.

`read:org` lets Seleya enumerate an organization's repositories and read
organization-level Type and Field definitions.

Fine-grained token: grant access to the specific organizations and repositories
(including private ones), with repository permissions `Issues: Read-only` and
`Metadata: Read-only`. Fine-grained tokens must be approved per organization by
an owner.

## Configuration

Configuration lives in `config.yaml` (see `config.example.yaml` for a complete
example, and [docs/config-reference.md](docs/config-reference.md) for the full
schema reference with filter recipes and a cheat sheet). Top-level keys:

| Key | Meaning |
| --- | --- |
| `username` | Your GitHub login, used to compute the catch-all tab. |
| `ttlMinutes` | How long cached data is considered fresh (default 10). |
| `syncConcurrency` | How many repositories to sync in parallel (default 6). |
| `bindAddress` | Network interface to bind (default `127.0.0.1`). |
| `port` | Port to listen on. |
| `caseSensitive` | When false (the default), issue filters match case-insensitively. |
| `forkAllowlist` | List of `owner/name` forks to include despite the fork exclusion. |
| `tabs` | The ordered list of tabs (see below). |

Seleya reads `config.yaml` once at startup, so restart the server after editing
it. Reordering, renaming, or regrouping tabs takes effect on restart alone.
Changes that alter which repositories a tab contains (match rules, `exclude`,
`forkAllowlist`) also need a refresh so Seleya can re-resolve membership from
GitHub.

### Tabs and repository matching

Each tab has a `name` and a `match` list. A tab's repositories are the union of
its match rules, and rule types may be mixed in one tab:

- `org: some-org` includes every repository Seleya can see in that organization.
- `repos: [owner/a, owner/b]` includes specific repositories by name.
- `catchAll: true` includes your own repositories that no other tab claims. If
  the catch-all matches nothing, its tab is not shown.

In `org` and `catchAll` matches, forks are excluded (unless listed in
`forkAllowlist`) and archived repositories are excluded. Naming a repository
explicitly in a `repos` rule overrides both exclusions.

A tab may also list `exclude: [owner/name, ...]` to remove specific repositories
from that tab after its match rules are applied. This works for every rule type,
including the catch-all. Excluding a repository only hides it from that tab; it
does not reassign the repository to another tab.

### Groups and filters

Within a tab, `groups` partitions issues into named, collapsible sections. A tab
with no groups shows a single section with all open issues and pull requests.

Each group has a `name` and an optional `filter`. A filter is a set of
dimensions (all ANDed): `type` (`issue` or `pull_request`), and the matcher
dimensions `labels`, `assignee`, `author`, `milestone`, `issueType`, `age`, and
`fields`. Each matcher dimension takes one matcher object or a list of them (a
list is ANDed), and a matcher combines optional keys: `include` / `exclude`
(any-of / none-of), `is` (exact), `like` (SQL `LIKE`), `set` (true/false), and
`gt` / `gte` / `lt` / `lte` (numeric, for number fields and `age`).

```yaml
filter:
  type: issue
  labels: { exclude: [triaged] }
  author: { like: '%bot%' }
  fields:
    - name: Priority
      include: [High, Critical]
```

String matching is case-insensitive by default (`like` always is). See
[docs/config-reference.md](docs/config-reference.md) for the complete matcher
reference, operator details, and recipes.

## How refreshing works

SQLite is the source of truth. The web UI reads only from SQLite, so it is fast
and works even when GitHub is unreachable. A refresh resolves the repository set,
records tab membership, and syncs each stale repository incrementally (fetching
only issues updated since the last sync, and removing issues that have closed).

A **deep refresh** (the button in the UI) additionally rediscovers Type and Field
definitions and reconciles deletions: issues removed or transferred on GitHub,
and repositories that have become archived or otherwise left the match set, are
removed locally.

## Development

```bash
npm test            # run the test suite
npm run typecheck   # type-check the server
npm run dev:client  # Vite dev server for the UI (proxies /api to the server)
npm run dev         # server with reload
```

## License

Apache License 2.0. See [LICENSE.md](LICENSE.md).
