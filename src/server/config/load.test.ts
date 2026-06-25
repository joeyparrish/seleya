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
    expect(config.caseSensitive).toBe(false);
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
      `username: octocat\ntabs:\n  - name: T\n    match:\n      - repos: ["notslashed"]\n`,
    );
    expect(() => loadConfig({ path, env: { GITHUB_TOKEN: "tok" } })).toThrow();
  });
});
