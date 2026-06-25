# Seleya configuration reference

This is the complete reference for `config.yaml`. It is generated from the same
shape the server validates (`src/server/config/schema.ts`), so it stays in step
with what Seleya actually accepts. For a runnable starting point, copy
`config.example.yaml`.

A few things that hold everywhere:

- **Unknown keys are rejected.** Every object is validated strictly, so a typo
  like `labelInclude` (missing the `s`) fails at startup with an error naming the
  bad key. That is a feature: it catches filter mistakes immediately.
- **The token is never in this file.** It comes from `GITHUB_TOKEN` (or
  `SELEYA_GITHUB_TOKEN`) in the environment.
- **Config is read once, at startup.** Restart the server after editing it.
  Reordering, renaming, or regrouping tabs takes effect on restart alone; changes
  to which repositories a tab contains (`match`, `exclude`, `forkAllowlist`) also
  need a refresh.

## Top level

```yaml
username: your-github-login      # required
ttlMinutes: 10                   # optional, default 10
syncConcurrency: 6               # optional, default 6
bindAddress: 127.0.0.1           # optional, default 127.0.0.1
port: 8080                       # optional, default 8080
caseSensitive: false             # optional, default false
forkAllowlist: []                # optional, default []
tabs: [ ... ]                    # required, at least one
```

| Key | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `username` | string | yes | | Your GitHub login. Used to compute the catch-all. |
| `ttlMinutes` | positive integer | no | `10` | Minutes before cached data is considered stale. |
| `syncConcurrency` | positive integer | no | `6` | How many repositories to sync in parallel. |
| `bindAddress` | string | no | `127.0.0.1` | Interface to bind. Do not change without external auth. |
| `port` | positive integer | no | `8080` | Port to listen on. |
| `caseSensitive` | boolean | no | `false` | When `false`, issue filters match case-insensitively (ASCII). See Filters. |
| `forkAllowlist` | list of `owner/name` | no | `[]` | Forks to include despite the fork exclusion. |
| `tabs` | list of tab | yes | | The ordered tabs (see below). At least one. |

## Tab

```yaml
- name: Shaka Project            # required
  match: [ ... ]                 # required, at least one rule
  exclude: [owner/name, ...]     # optional
  groups: [ ... ]                # optional
```

| Key | Type | Required | Meaning |
| --- | --- | --- | --- |
| `name` | string | yes | Tab label. Also the value stored in the URL hash. |
| `match` | list of match rule | yes | Repositories in this tab are the union of these rules. |
| `exclude` | list of `owner/name` | no | Repositories to remove from this tab after matching. |
| `groups` | list of group | no | Named issue groupings. With none, the tab shows one group of all open items. |

### Match rules

A tab's repositories are the **union** of its match rules, and rule types may be
mixed in one tab. Each rule is exactly one of:

```yaml
- org: shaka-project             # every repo Seleya can see in this org
- repos: [owner/a, owner/b]      # specific repos by owner/name
- catchAll: true                 # your repos not claimed by any other tab
```

- In `org` and `catchAll` matches, **forks are excluded** (unless listed in
  `forkAllowlist`) and **archived repositories are excluded**.
- Naming a repository explicitly in a `repos` rule **overrides** both exclusions.
- `exclude` is applied after the union and removes the named repositories from
  this tab only (it does not move them to another tab). It works on every rule
  type, including the catch-all.
- If the catch-all matches nothing, its tab is not shown.

## Group

```yaml
- name: Needs triage             # required
  filter: { ... }                # optional
```

| Key | Type | Required | Meaning |
| --- | --- | --- | --- |
| `name` | string | yes | Section heading shown in the tab. |
| `filter` | filter object | no | Conditions for which issues appear. With none, the group shows all open items for the tab's repos. |

A tab with no `groups` is equivalent to one group named "All open issues and PRs"
with no filter.

## Filters

A filter is an object of **dimensions**, all ANDed together (every dimension
present must match). `type` is a plain enum; every other dimension is a
**matcher** (or a list of matchers). Only open issues and pull requests exist in
Seleya, so there is no "state" dimension.

| Dimension | Kind | Matched against |
| --- | --- | --- |
| `type` | enum `issue` \| `pull_request` | Issue vs pull request (not a matcher). |
| `labels` | matcher(s), set | The issue's labels. |
| `assignee` | matcher(s), set | The issue's assignees. |
| `author` | matcher(s), scalar | The author login. |
| `milestone` | matcher(s), scalar | The milestone title. |
| `issueType` | matcher(s), scalar | The beta issue Type name. |
| `age` | matcher(s), numeric | The issue's age in days (numeric operators only). |
| `fields` | list of field matchers | Beta custom Fields, by name (see below). |

### Matchers: one object or a list

Every matcher dimension (everything except `type` and `fields`) accepts
**either a single matcher object or a list of matcher objects**. Both forms are
valid and mean different things, so this is worth calling out explicitly:

```yaml
author: { like: '%bot%' }     # object form: one matcher

labels:                       # list form: several matchers
  - include: [security]
  - exclude: [frontend]
```

A **list is ANDed**: every matcher in it must hold. Within a single matcher, the
keys present are also ANDed. So you express OR with `include` inside one matcher,
and AND with multiple matchers in a list.

A matcher has these optional keys:

| Key | Type | Meaning |
| --- | --- | --- |
| `include` | list of string | The value is **any of** these (OR). |
| `exclude` | list of string | The value is **none of** these. A missing value also matches. |
| `is` | string | Exact equality (same as `include` with one item). |
| `like` | string | SQL `LIKE` pattern (`%` and `_`). Always case-insensitive. |
| `set` | boolean | Has a value (`true`) or has no value (`false`). |
| `gt` `gte` `lt` `lte` | number | Numeric comparison (number fields and `age`). |

`include`, `exclude`, and `is` are case-insensitive by default; set the
top-level `caseSensitive: true` for exact case. `like` is always
case-insensitive (ASCII folding only). Repository and organization name matching
is always case-insensitive regardless of this setting.

For **set dimensions** (`labels`, `assignee`), `include` means "has any of
these", `exclude` means "has none of these", and `set: false` means "has none at
all" (so `assignee: { set: false }` is unassigned). For **scalar dimensions**
(`author`, `milestone`, `issueType`), the matcher tests the single value, and
`set: false` means the value is absent (e.g. no milestone). For **`age`**, only
the numeric operators apply.

### Field matchers

Each entry in `fields` is a matcher plus a required `name`, targeting one beta
custom Field. Fields are matched **by name across organizations**: a `Priority`
condition applies wherever a `Priority` field exists. Issues in organizations
that do not define the field have no value for it, so they do not match
`include`, `is`, or numeric conditions, and they do match `exclude` and
`set: false`.

```yaml
fields:
  - name: Priority             # required
    include: [High, Critical]  # select/text: value is any of these
    exclude: [Deferred]        #   and none of these
  - name: Effort               # number field:
    gte: 3                     #   numeric comparison
  - name: Department           # any field:
    set: false                 #   the issue has no value for this field
```

By data type: `include` / `exclude` / `is` / `like` apply to single-select,
multi-select, and text fields (they compare the text value); `gt` / `gte` / `lt`
/ `lte` apply to number fields; `set` applies to any field. Multiple keys in one
field entry are ANDed; list the same field name twice to AND separate clauses.

## Operators

- String operators (`include`, `exclude`, `is`): membership or equality,
  case-insensitive unless `caseSensitive: true`.
- `like`: SQL `LIKE` with `%` (any run of characters) and `_` (any one
  character), always case-insensitive.
- Numeric operators (`gt`, `gte`, `lt`, `lte`): apply to number fields and to
  `age`. For `age` the value is days and larger means older, so `age: { gte: 7 }`
  means "at least 7 days old".

## Recipes

Untriaged issues (no `triaged` label):

```yaml
- name: Needs triage
  filter:
    type: issue
    labels: { exclude: [triaged] }
```

Dependabot and other bots:

```yaml
- name: Bots
  filter:
    type: pull_request
    author: { like: '%bot%' }
```

Unassigned, high-or-critical priority issues:

```yaml
- name: Grab these
  filter:
    type: issue
    assignee: { set: false }
    fields:
      - name: Priority
        include: [High, Critical]
```

Bugs older than 30 days:

```yaml
- name: Aging bugs
  filter:
    issueType: { include: [Bug] }
    age: { gte: 30 }
```

Issues with both `security` and `UX` labels but not `frontend` (AND via a list):

```yaml
- name: Security UX
  filter:
    labels:
      - include: [security]
      - include: [UX]
      - exclude: [frontend]
```

Large-effort issues whose priority is still unset:

```yaml
- name: Size it
  filter:
    fields:
      - name: Effort
        gte: 5
      - name: Priority
        set: false
```

## Cheat sheet

```yaml
filter:
  type: issue                  # or: pull_request (not a matcher)

  # Every dimension below is a matcher OR a list of matchers (a list is ANDed).
  labels:    { include: [a, b], exclude: [c] }   # set: any-of / none-of
  assignee:  { set: false }                      # unassigned
  author:    { like: '%bot%' }                   # fuzzy
  milestone: { is: "v1.0" }                      # exact
  issueType: { include: [Bug, Task] }            # any-of
  age:       { gte: 7 }                          # at least 7 days old

  fields:
    - name: Priority
      include: [High]          # select/text: value in list
      exclude: [Low]           #   and not in list
    - name: Effort
      gte: 3                   # number: gt gte lt lte
    - name: Department
      set: false               # no value for this field

# Matcher keys (all optional, ANDed):
#   include: [str]   exclude: [str]   is: str   like: str
#   set: bool        gt | gte | lt | lte: number
```
