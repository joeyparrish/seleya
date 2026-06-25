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

  // Config can be supplied inline via SELEYA_CONFIG_YAML (simplest for container
  // deployments, no file mount needed), otherwise it is read from a file.
  const raw = env.SELEYA_CONFIG_YAML ?? readFileSync(opts?.path ?? env.SELEYA_CONFIG ?? "config.yaml", "utf8");
  const config = configSchema.parse(parseYaml(raw));

  // Deployment env overrides keep network settings out of the user's config, so
  // the same config works locally and in a container.
  if (env.PORT !== undefined && env.PORT !== "") {
    const port = Number(env.PORT);
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`Invalid PORT: ${env.PORT}`);
    }
    config.port = port;
  }
  if (env.SELEYA_BIND_ADDRESS) {
    config.bindAddress = env.SELEYA_BIND_ADDRESS;
  }

  const token = env.GITHUB_TOKEN ?? env.SELEYA_GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "No GitHub token found. Set GITHUB_TOKEN (or SELEYA_GITHUB_TOKEN) in the environment.",
    );
  }

  return { config, token };
}
