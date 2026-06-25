import type { Config, Tab } from "../config/schema.js";
import type { GitHubClient } from "../github/client.js";
import type { RepoInfo } from "../github/types.js";

export interface ResolvedTab {
  name: string;
  repos: RepoInfo[];
  tab: Tab;
}

type Discovery = Pick<GitHubClient, "listOrgRepos" | "listUserRepos" | "getRepo">;

function key(owner: string, name: string): string {
  return `${owner}/${name}`.toLowerCase();
}

export async function resolveRepos(
  config: Config,
  client: Discovery,
): Promise<{ tabs: ResolvedTab[]; allRepos: RepoInfo[] }> {
  const allow = new Set(config.forkAllowlist.map((r) => r.toLowerCase()));
  const orgCache = new Map<string, RepoInfo[]>();
  let userRepos: RepoInfo[] | null = null;

  const getOrg = async (org: string): Promise<RepoInfo[]> => {
    if (!orgCache.has(org)) orgCache.set(org, await client.listOrgRepos(org));
    return orgCache.get(org)!;
  };
  const getUser = async (): Promise<RepoInfo[]> => {
    if (userRepos === null) userRepos = await client.listUserRepos(config.username);
    return userRepos;
  };

  const keep = (r: RepoInfo): boolean => !r.isFork || allow.has(key(r.owner, r.name));

  // First pass: resolve every non-catch-all rule, tracking which repos are "claimed".
  const claimed = new Set<string>();
  const knownByKey = new Map<string, RepoInfo>();
  const register = (r: RepoInfo) => knownByKey.set(key(r.owner, r.name), r);

  const explicitTabRepos: RepoInfo[][] = [];
  for (const tab of config.tabs) {
    const set = new Map<string, RepoInfo>();
    for (const rule of tab.match) {
      if ("org" in rule) {
        for (const r of await getOrg(rule.org)) {
          register(r);
          if (keep(r)) {
            set.set(r.id, r);
            claimed.add(key(r.owner, r.name));
          }
        }
      } else if ("repos" in rule) {
        for (const spec of rule.repos) claimed.add(spec.toLowerCase());
      }
    }
    explicitTabRepos.push([...set.values()]);
  }

  // Make user repos available for explicit-spec resolution and catch-all.
  for (const r of await getUser()) register(r);

  // Second pass: finalize each tab (resolve explicit specs, compute catch-all).
  const tabs: ResolvedTab[] = [];
  for (let idx = 0; idx < config.tabs.length; idx++) {
    const tab = config.tabs[idx];
    const set = new Map<string, RepoInfo>();
    for (const r of explicitTabRepos[idx]) set.set(r.id, r);

    for (const rule of tab.match) {
      if ("repos" in rule) {
        for (const spec of rule.repos) {
          let r = knownByKey.get(spec.toLowerCase());
          if (!r) {
            // Explicit repos that no org/user rule discovered must be fetched
            // directly — this is the not-related-by-an-org case.
            const [owner, name] = spec.split("/");
            const fetched = await client.getRepo(owner, name);
            if (fetched) {
              register(fetched);
              r = fetched;
            }
          }
          if (r && keep(r)) set.set(r.id, r);
        }
      } else if ("catchAll" in rule) {
        for (const r of userRepos!) {
          if (!keep(r)) continue;
          if (claimed.has(key(r.owner, r.name))) continue;
          set.set(r.id, r);
        }
      }
    }

    const repos = [...set.values()];
    const isCatchAll = tab.match.some((m) => "catchAll" in m);
    if (isCatchAll && repos.length === 0) continue; // omit empty catch-all
    tabs.push({ name: tab.name, repos, tab });
  }

  const all = new Map<string, RepoInfo>();
  for (const t of tabs) for (const r of t.repos) all.set(r.id, r);

  return { tabs, allRepos: [...all.values()] };
}
