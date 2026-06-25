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
    notIn: z.array(z.string()).optional(),
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
    exclude: z.array(repoName).optional(),
    groups: z.array(groupSchema).optional(),
  })
  .strict();

export const configSchema = z
  .object({
    username: z.string().min(1),
    ttlMinutes: z.number().int().positive().default(10),
    syncConcurrency: z.number().int().positive().default(6),
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
