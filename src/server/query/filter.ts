import type { GroupFilter } from "../config/schema.js";

export interface CompiledFilter {
  where: string;
  params: unknown[];
}

const NUMERIC_OPS: Record<string, string> = {
  ">": ">",
  ">=": ">=",
  "<": "<",
  "<=": "<=",
  "=": "=",
  "!=": "!=",
};

const DAY_MS = 86_400_000;

/**
 * Compiles a group's structured filter into a parameterized SQL WHERE clause
 * over the `issues` table (joined to its satellite tables via EXISTS). Always
 * scopes to the given repo ids; an empty repo set matches nothing.
 */
export function compileFilter(
  filter: GroupFilter | undefined,
  repoIds: string[],
  now: Date,
): CompiledFilter {
  if (repoIds.length === 0) return { where: "0", params: [] };

  const conditions: string[] = [];
  const params: unknown[] = [];

  conditions.push(`issues.repo_id IN (${repoIds.map(() => "?").join(", ")})`);
  params.push(...repoIds);

  if (filter) {
    if (filter.type) {
      conditions.push("issues.is_pull_request = ?");
      params.push(filter.type === "pull_request" ? 1 : 0);
    }

    for (const label of filter.labelsInclude ?? []) {
      conditions.push(
        "EXISTS (SELECT 1 FROM issue_labels l WHERE l.issue_id = issues.id AND l.label = ?)",
      );
      params.push(label);
    }

    for (const label of filter.labelsExclude ?? []) {
      conditions.push(
        "NOT EXISTS (SELECT 1 FROM issue_labels l WHERE l.issue_id = issues.id AND l.label = ?)",
      );
      params.push(label);
    }

    if (filter.assignee !== undefined) {
      conditions.push("EXISTS (SELECT 1 FROM json_each(issues.assignees) WHERE value = ?)");
      params.push(filter.assignee);
    }

    if (filter.author !== undefined) {
      conditions.push("issues.author = ?");
      params.push(filter.author);
    }

    if (filter.milestone !== undefined) {
      conditions.push("issues.milestone = ?");
      params.push(filter.milestone);
    }

    if (filter.issueType && filter.issueType.length > 0) {
      conditions.push(`issues.issue_type_name IN (${filter.issueType.map(() => "?").join(", ")})`);
      params.push(...filter.issueType);
    }

    if (filter.ageDays) {
      const cutoff = new Date(now.getTime() - filter.ageDays.value * DAY_MS).toISOString();
      // Age grows as created_at shrinks, so an age comparison inverts into a
      // created_at comparison against the cutoff.
      const inverted: Record<string, string> = { ">": "<", ">=": "<=", "<": ">", "<=": ">=" };
      conditions.push(`issues.created_at ${inverted[filter.ageDays.op]} ?`);
      params.push(cutoff);
    }

    for (const f of filter.fields ?? []) {
      if (f.in && f.in.length > 0) {
        conditions.push(
          `EXISTS (SELECT 1 FROM issue_field_values v WHERE v.issue_id = issues.id AND v.field_name = ? AND v.value_text IN (${f.in
            .map(() => "?")
            .join(", ")}))`,
        );
        params.push(f.name, ...f.in);
      }
      if (f.notIn && f.notIn.length > 0) {
        // Matches when the field has none of these values, including issues that
        // have no value for the field at all (mirrors labelsExclude).
        conditions.push(
          `NOT EXISTS (SELECT 1 FROM issue_field_values v WHERE v.issue_id = issues.id AND v.field_name = ? AND v.value_text IN (${f.notIn
            .map(() => "?")
            .join(", ")}))`,
        );
        params.push(f.name, ...f.notIn);
      }
      if (f.op !== undefined && f.value !== undefined) {
        const op = NUMERIC_OPS[f.op];
        if (!op) throw new Error(`Unsupported field operator: ${f.op}`);
        conditions.push(
          `EXISTS (SELECT 1 FROM issue_field_values v WHERE v.issue_id = issues.id AND v.field_name = ? AND v.value_number ${op} ?)`,
        );
        params.push(f.name, f.value);
      }
      if (f.unset) {
        conditions.push(
          "NOT EXISTS (SELECT 1 FROM issue_field_values v WHERE v.issue_id = issues.id AND v.field_name = ?)",
        );
        params.push(f.name);
      }
    }
  }

  return { where: conditions.join(" AND "), params };
}
