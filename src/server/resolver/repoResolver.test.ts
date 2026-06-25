import { describe, it, expect } from "vitest";
import { resolveRepos } from "./repoResolver.js";
import type { RepoInfo } from "../github/types.js";
import type { Config } from "../config/schema.js";

function repo(
  id: string,
  owner: string,
  name: string,
  flags: { isFork?: boolean; isArchived?: boolean } = {},
): RepoInfo {
  return { id, owner, name, isFork: flags.isFork ?? false, isArchived: flags.isArchived ?? false };
}

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
  syncConcurrency: 6,
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
            repo("R_1", "org", "lib"),
            repo("R_2", "org", "droppedfork", { isFork: true }),
            repo("R_3", "org", "keptfork", { isFork: true }),
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
          org1: [repo("R_1", "org1", "a")],
          org2: [repo("R_2", "org2", "foo"), repo("R_3", "org2", "bar")],
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
        orgs: { org: [repo("R_1", "org", "lib")] },
        user: [repo("R_2", "octocat", "dotfiles"), repo("R_1", "org", "lib")],
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
        orgs: { org: [repo("R_1", "org", "lib")] },
        user: [repo("R_1", "org", "lib")],
      }),
    );
    expect(repos.tabs.map((t) => t.name)).toEqual(["Org"]);
  });

  it("skips archived repos in org and catch-all matches but keeps them when named explicitly", async () => {
    const c = cfg({
      tabs: [
        { name: "Org", match: [{ org: "org" }] },
        { name: "Explicit", match: [{ repos: ["org/oldlib"] }] },
        { name: "Personal", match: [{ catchAll: true }] },
      ],
    });
    const repos = await resolveRepos(
      c,
      client({
        orgs: {
          org: [repo("R_1", "org", "lib"), repo("R_2", "org", "oldlib", { isArchived: true })],
        },
        user: [repo("R_3", "octocat", "active"), repo("R_4", "octocat", "retired", { isArchived: true })],
      }),
    );
    const org = repos.tabs.find((t) => t.name === "Org")!;
    expect(org.repos.map((r) => r.id)).toEqual(["R_1"]); // archived R_2 skipped

    const explicit = repos.tabs.find((t) => t.name === "Explicit")!;
    expect(explicit.repos.map((r) => r.id)).toEqual(["R_2"]); // archived but named explicitly

    const personal = repos.tabs.find((t) => t.name === "Personal")!;
    expect(personal.repos.map((r) => r.id)).toEqual(["R_3"]); // archived R_4 skipped
  });
});
