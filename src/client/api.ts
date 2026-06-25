import type { RefreshStatus, TabSummary, TabView } from "./types";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export function getTabs(): Promise<{ tabs: TabSummary[] }> {
  return getJson("/api/tabs");
}

export function getTab(index: number): Promise<TabView> {
  return getJson(`/api/tabs/${index}`);
}

export function getRefreshStatus(): Promise<RefreshStatus> {
  return getJson("/api/refresh/status");
}

export async function postRefresh(deep: boolean): Promise<RefreshStatus> {
  const res = await fetch(`/api/refresh${deep ? "?deep=true" : ""}`, { method: "POST" });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as RefreshStatus;
}
