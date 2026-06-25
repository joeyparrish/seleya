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

A filter is an object of conditions. **All conditions must match** (they are
ANDed together). Only open issues and pull requests exist in Seleya, so there is
no "state" condition.

String comparisons (labels, assignee, author, milestone, issue type, and field
names and values) are **case-insensitive by default**. Set the top-level
`caseSensitive: true` to require exact case. (Folding is ASCII only.) Repository
and organization name matching is always case-insensitive regardless of this
setting.

| Key | Type | Meaning |
| --- | --- | --- |
| `labelsInclude` | list of string | Issue must have **all** of these labels. |
| `labelsExclude` | list of string | Issue must have **none** of these labels. |
| `type` | `issue` or `pull_request` | Restrict to issues or to pull requests. |
| `assignee` | string | Exact assignee login (the issue must have this assignee). |
| `author` | string | Exact author login. |
| `milestone` | string | Exact milestone title. |
| `ageDays` | `{ op, value }` | Compare the issue's age in days (see operators). |
| `issueType` | list of string | Issue's beta Type name is **one of** these (e.g. `Bug`). |
| `fields` | list of field filter | Conditions on beta custom Fields (see below). |

Notes:

- `labelsInclude` is an AND across the listed labels; `labelsExclude` removes an
  issue if it carries any one of the listed labels.
- `issueType` is an OR: the issue matches if its Type is any name in the list.
- `assignee`, `author`, and `milestone` are exact, single-value matches. There is
  no built-in "unassigned" or "no milestone" condition yet.

### Field filters

Each entry in `fields` targets one beta custom Field by `name` and is matched
**by field name across organizations**: a `Priority` condition applies wherever a
`Priority` field exists. Issues in organizations that do not define the field do
not match `in` or numeric conditions, and do match `notIn` and `unset: true`.

```yaml
fields:
  - name: Priority               # required: the field name
    in: [High, Critical]         # select/text fields: value is one of these
  - name: Status                 # select/text fields:
    notIn: [Done, Closed]        #   value is none of these
  - name: Effort                 # number fields:
    op: ">="                     #   one of > >= < <= = !=
    value: 3
  - name: Target date            # any field:
    unset: true                  #   the issue has no value for this field
```

| Key | Type | Applies to | Meaning |
| --- | --- | --- | --- |
| `name` | string | required | The field's name. |
| `in` | list of string | single/multi-select, text | Field value is one of these. |
| `notIn` | list of string | single/multi-select, text | Field value is none of these. Issues with no value for the field also match. |
| `op` + `value` | operator + number | number fields | Numeric comparison against `value`. |
| `unset` | `true` | any field | The issue has no value set for this field. |

Within one field filter you may combine keys (for example `name` + `in`), and
they are ANDed. Use separate entries for separate fields.

## Operators

Two condition types take operators, and their allowed sets differ:

- `ageDays.op`: one of `>` `>=` `<` `<=`. (No `=` or `!=`.)
  Age grows as the issue gets older, so `{ op: ">=", value: 7 }` means "at least
  7 days old".
- field filter `op`: one of `>` `>=` `<` `<=` `=` `!=`.

## Recipes

Untriaged issues (issues without a `triaged` label):

```yaml
- name: Needs triage
  filter:
    type: issue
    labelsExclude: [triaged]
```

High or critical priority pull requests:

```yaml
- name: Hot PRs
  filter:
    type: pull_request
    fields:
      - name: Priority
        in: [High, Critical]
```

Bugs older than 30 days:

```yaml
- name: Aging bugs
  filter:
    issueType: [Bug]
    ageDays: { op: ">=", value: 30 }
```

Large-effort issues with a priority still unset:

```yaml
- name: Size it
  filter:
    type: issue
    fields:
      - name: Effort
        op: ">="
        value: 5
      - name: Priority
        unset: true
```

Everything by a specific author with two required labels:

```yaml
- name: Alice's regressions
  filter:
    author: alice
    labelsInclude: [bug, regression]
```

## Cheat sheet

```yaml
filter:
  labelsInclude: [a, b]          # has all of these labels
  labelsExclude: [c, d]          # has none of these labels
  type: issue                    # or: pull_request
  assignee: somelogin            # exact
  author: somelogin              # exact
  milestone: "v1.0"              # exact
  ageDays: { op: ">=", value: 7 }   # op: > >= < <=
  issueType: [Bug, Task]         # type name is one of these
  fields:
    - name: Priority
      in: [High]                 # select/text: value in list
    - name: Status
      notIn: [Done]              # select/text: value not in list
    - name: Effort
      op: ">="                   # number: > >= < <= = !=
      value: 3
    - name: Priority
      unset: true                # no value for this field
```
