import { z } from "zod";

const repoName = z.string().regex(/^[^/]+\/[^/]+$/, "must be in owner/name form");

const orgRule = z.object({ org: z.string().min(1) }).strict();
const reposRule = z.object({ repos: z.array(repoName).min(1) }).strict();
const catchAllRule = z.object({ catchAll: z.literal(true) }).strict();
export const matchRuleSchema = z.union([orgRule, reposRule, catchAllRule]);

// A matcher is a set of optional conditions, all ANDed together.
const matcherShape = {
  include: z.array(z.string()).optional(), // value is any of these
  exclude: z.array(z.string()).optional(), // value is none of these
  is: z.string().optional(), // exact equality
  like: z.string().optional(), // SQL LIKE pattern (% and _), always case-insensitive
  set: z.boolean().optional(), // has a value (true) / has no value (false)
  gt: z.number().optional(),
  gte: z.number().optional(),
  lt: z.number().optional(),
  lte: z.number().optional(),
};

export const matcherSchema = z.object(matcherShape).strict();
export const fieldMatcherSchema = z.object({ ...matcherShape, name: z.string().min(1) }).strict();

// Each dimension accepts a single matcher or a list of matchers; a list is ANDed.
const matchers = z.union([matcherSchema, z.array(matcherSchema)]);

export const groupFilterSchema = z
  .object({
    type: z.enum(["issue", "pull_request"]).optional(),
    labels: matchers.optional(),
    assignee: matchers.optional(),
    author: matchers.optional(),
    milestone: matchers.optional(),
    issueType: matchers.optional(),
    age: matchers.optional(),
    fields: z.array(fieldMatcherSchema).optional(),
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
    port: z.number().int().positive().default(7920),
    allowedHosts: z.array(z.string()).default([]),
    caseSensitive: z.boolean().default(false),
    forkAllowlist: z.array(repoName).default([]),
    tabs: z.array(tabSchema).min(1),
  })
  .strict();

export type MatchRule = z.infer<typeof matchRuleSchema>;
export type Matcher = z.infer<typeof matcherSchema>;
export type FieldMatcher = z.infer<typeof fieldMatcherSchema>;
export type GroupFilter = z.infer<typeof groupFilterSchema>;
export type Group = z.infer<typeof groupSchema>;
export type Tab = z.infer<typeof tabSchema>;
export type Config = z.infer<typeof configSchema>;
