import type { GroupFilter, Matcher } from "../config/schema.js";

export interface CompiledFilter {
  where: string;
  params: unknown[];
}

const DAY_MS = 86_400_000;

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

function asList<T>(x: T | T[] | undefined): T[] {
  if (x === undefined) return [];
  return Array.isArray(x) ? x : [x];
}

interface Acc {
  conditions: string[];
  params: unknown[];
}

/**
 * Collection-style dimension (labels, assignees, custom fields): the value lives
 * in rows of `source` correlated to the issue by `corr`. `scopeParams` supplies
 * params for any placeholders inside `corr` (e.g. the field name) and is pushed
 * once per emitted EXISTS. `c` is the COLLATE suffix for case folding.
 */
function collectionMatcher(
  acc: Acc,
  m: Matcher,
  opts: {
    source: string;
    corr: string;
    textCol: string;
    numCol: string | null;
    scopeParams: unknown[];
    c: string;
  },
): void {
  const { source, corr, textCol, numCol, scopeParams, c } = opts;
  const add = (negate: boolean, extra: string, params: unknown[]) => {
    const where = extra ? `${corr} AND ${extra}` : corr;
    acc.conditions.push(
      `${negate ? "NOT EXISTS" : "EXISTS"} (SELECT 1 FROM ${source} WHERE ${where})`,
    );
    acc.params.push(...scopeParams, ...params);
  };

  if (m.include && m.include.length > 0) {
    add(false, `${textCol}${c} IN (${placeholders(m.include.length)})`, m.include);
  }
  if (m.exclude && m.exclude.length > 0) {
    add(true, `${textCol}${c} IN (${placeholders(m.exclude.length)})`, m.exclude);
  }
  if (m.is !== undefined) add(false, `${textCol}${c} = ?`, [m.is]);
  // LIKE is always case-insensitive (ASCII), independent of the caseSensitive flag.
  if (m.like !== undefined) add(false, `${textCol} LIKE ?`, [m.like]);
  if (m.set !== undefined) add(!m.set, "", []);
  if (numCol) {
    if (m.gt !== undefined) add(false, `${numCol} > ?`, [m.gt]);
    if (m.gte !== undefined) add(false, `${numCol} >= ?`, [m.gte]);
    if (m.lt !== undefined) add(false, `${numCol} < ?`, [m.lt]);
    if (m.lte !== undefined) add(false, `${numCol} <= ?`, [m.lte]);
  }
}

/**
 * Scalar-style dimension (author, milestone, issue type): a single column
 * expression `E` that may be NULL. "No value" matches `exclude` and `set: false`.
 */
function scalarMatcher(acc: Acc, m: Matcher, E: string, c: string): void {
  if (m.include && m.include.length > 0) {
    acc.conditions.push(`${E}${c} IN (${placeholders(m.include.length)})`);
    acc.params.push(...m.include);
  }
  if (m.exclude && m.exclude.length > 0) {
    acc.conditions.push(`(${E} IS NULL OR ${E}${c} NOT IN (${placeholders(m.exclude.length)}))`);
    acc.params.push(...m.exclude);
  }
  if (m.is !== undefined) {
    acc.conditions.push(`${E}${c} = ?`);
    acc.params.push(m.is);
  }
  if (m.like !== undefined) {
    acc.conditions.push(`${E} LIKE ?`);
    acc.params.push(m.like);
  }
  if (m.set !== undefined) {
    acc.conditions.push(m.set ? `${E} IS NOT NULL` : `${E} IS NULL`);
  }
}

/**
 * Age dimension: numeric comparisons on the issue's age in days, mapped to a
 * `created_at` cutoff (older issues have a smaller created_at). Only the numeric
 * operators apply.
 */
function ageMatcher(acc: Acc, m: Matcher, now: Date): void {
  const cutoff = (days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();
  if (m.gt !== undefined) {
    acc.conditions.push("issues.created_at < ?");
    acc.params.push(cutoff(m.gt));
  }
  if (m.gte !== undefined) {
    acc.conditions.push("issues.created_at <= ?");
    acc.params.push(cutoff(m.gte));
  }
  if (m.lt !== undefined) {
    acc.conditions.push("issues.created_at > ?");
    acc.params.push(cutoff(m.lt));
  }
  if (m.lte !== undefined) {
    acc.conditions.push("issues.created_at >= ?");
    acc.params.push(cutoff(m.lte));
  }
}

/**
 * Compiles a group's structured filter into a parameterized SQL WHERE clause
 * over the `issues` table (joined to its satellite tables via EXISTS). Always
 * scopes to the given repo ids; an empty repo set matches nothing.
 *
 * String comparisons (include/exclude/is) are case-insensitive by default and
 * become case-sensitive when `caseSensitive` is true; `like` is always
 * case-insensitive. SQLite NOCASE folds ASCII case only.
 */
export function compileFilter(
  filter: GroupFilter | undefined,
  repoIds: string[],
  now: Date,
  caseSensitive = false,
): CompiledFilter {
  if (repoIds.length === 0) return { where: "0", params: [] };
  const c = caseSensitive ? "" : " COLLATE NOCASE";
  const acc: Acc = { conditions: [], params: [] };

  acc.conditions.push(`issues.repo_id IN (${placeholders(repoIds.length)})`);
  acc.params.push(...repoIds);

  if (filter) {
    if (filter.type) {
      acc.conditions.push("issues.is_pull_request = ?");
      acc.params.push(filter.type === "pull_request" ? 1 : 0);
    }

    for (const m of asList(filter.labels)) {
      collectionMatcher(acc, m, {
        source: "issue_labels l",
        corr: "l.issue_id = issues.id",
        textCol: "l.label",
        numCol: null,
        scopeParams: [],
        c,
      });
    }

    for (const m of asList(filter.assignee)) {
      collectionMatcher(acc, m, {
        source: "json_each(issues.assignees)",
        corr: "1",
        textCol: "value",
        numCol: null,
        scopeParams: [],
        c,
      });
    }

    for (const m of asList(filter.author)) scalarMatcher(acc, m, "issues.author", c);
    for (const m of asList(filter.milestone)) scalarMatcher(acc, m, "issues.milestone", c);
    for (const m of asList(filter.issueType)) scalarMatcher(acc, m, "issues.issue_type_name", c);
    for (const m of asList(filter.age)) ageMatcher(acc, m, now);

    for (const f of filter.fields ?? []) {
      collectionMatcher(acc, f, {
        source: "issue_field_values v",
        corr: `v.issue_id = issues.id AND v.field_name${c} = ?`,
        textCol: "v.value_text",
        numCol: "v.value_number",
        scopeParams: [f.name],
        c,
      });
    }
  }

  return { where: acc.conditions.join(" AND "), params: acc.params };
}
