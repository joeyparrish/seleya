import { describe, it, expect } from "vitest";
import { resolveRepos } from "./repoResolver.js";
import type { RepoInfo } from "../github/types.js";
import type { Config } from "../config/schema.js";

function client(data: { orgs?: Record<string, RepoInfo[]>; user?: RepoInfo[] }) {
  const all = [...Object.values(data.orgs ?? {}).flat(), ...(data.user ?? [])];
  return {
    listOrgRepos: async (org: string) => data.orgs?.[org] ?? [],
    listUserRepos: async () => data.user ?? [],
    getRepo: async (owner: string, name: string) =>
      all.find((r) => r.owner === owner && r.name === name) ?? null,
  };
}

const cfg = (over: Partial<Config>): Config => ({
  username: "octocat",
  ttlMinutes: 10,
  bindAddress: "127.0.0.1",
  port: 8080,
  forkAllowlist: [],
  tabs: [],
  ...over,
});

describe("resolveRepos", () => {
  it("expands an org and excludes forks unless allowlisted", async () => {
    const c = cfg({
      forkAllowlist: ["org/keptfork"],
      tabs: [{ name: "Org", match: [{ org: "org" }] }],
    });
    const repos = await resolveRepos(
      c,
      client({
        orgs: {
          org: [
            { id: "R_1", owner: "org", name: "lib", isFork: false },
            { id: "R_2", owner: "org", name: "droppedfork", isFork: true },
            { id: "R_3", owner: "org", name: "keptfork", isFork: true },
          ],
        },
      }),
    );
    expect(repos.tabs[0].repos.map((r) => r.name).sort()).toEqual(["keptfork", "lib"]);
  });

  it("unions mixed rules within one tab", async () => {
    const c = cfg({
      tabs: [
        {
          name: "Mixed",
          match: [{ org: "org1" }, { repos: ["org2/foo"] }],
        },
      ],
    });
    const repos = await resolveRepos(
      c,
      client({
        orgs: {
          org1: [{ id: "R_1", owner: "org1", name: "a", isFork: false }],
          org2: [
            { id: "R_2", owner: "org2", name: "foo", isFork: false },
            { id: "R_3", owner: "org2", name: "bar", isFork: false },
          ],
        },
        user: [],
      }),
    );
    expect(repos.tabs[0].repos.map((r) => r.id).sort()).toEqual(["R_1", "R_2"]);
  });

  it("computes catch-all as user repos not claimed by other tabs", async () => {
    const c = cfg({
      tabs: [
        { name: "Org", match: [{ org: "org" }] },
        { name: "Personal", match: [{ catchAll: true }] },
      ],
    });
    const repos = await resolveRepos(
      c,
      client({
        orgs: { org: [{ id: "R_1", owner: "org", name: "lib", isFork: false }] },
        user: [
          { id: "R_2", owner: "octocat", name: "dotfiles", isFork: false },
          { id: "R_1", owner: "org", name: "lib", isFork: false },
        ],
      }),
    );
    const personal = repos.tabs.find((t) => t.name === "Personal")!;
    expect(personal.repos.map((r) => r.id)).toEqual(["R_2"]);
  });

  it("omits an empty catch-all tab", async () => {
    const c = cfg({
      tabs: [
        { name: "Org", match: [{ org: "org" }] },
        { name: "Personal", match: [{ catchAll: true }] },
      ],
    });
    const repos = await resolveRepos(
      c,
      client({
        orgs: { org: [{ id: "R_1", owner: "org", name: "lib", isFork: false }] },
        user: [{ id: "R_1", owner: "org", name: "lib", isFork: false }],
      }),
    );
    expect(repos.tabs.map((t) => t.name)).toEqual(["Org"]);
  });
});
