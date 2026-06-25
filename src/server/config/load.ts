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
