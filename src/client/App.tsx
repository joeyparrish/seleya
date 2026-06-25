import { useEffect, useState } from "react";
import { Alert, AppShell, Center, Group, Loader, Tabs, Text, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { getTabs } from "./api";
import { TabPanel } from "./components/TabPanel";
import { RefreshControls } from "./components/RefreshControls";

function readHash(): string | null {
  const raw = window.location.hash.replace(/^#/, "");
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function App() {
  const { data, isLoading, error } = useQuery({ queryKey: ["tabs"], queryFn: getTabs });
  const [reloadWhenReady, setReloadWhenReady] = useState(false);
  const [active, setActive] = useState<string | null>(readHash);

  // Keep the active tab in sync with the URL hash (e.g. browser back/forward).
  useEffect(() => {
    const onHashChange = () => setActive(readHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const tabs = data?.tabs ?? [];
  const names = tabs.map((t) => t.name);
  // The hash holds the tab name. Fall back to the first tab if it no longer exists.
  const current = active && names.includes(active) ? active : (names[0] ?? null);

  const handleTabChange = (value: string | null) => {
    setActive(value);
    window.location.hash = value ? encodeURIComponent(value) : "";
  };

  return (
    <AppShell header={{ height: 56 }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Title order={3}>Seleya</Title>
          <RefreshControls
            reloadWhenReady={reloadWhenReady}
            onReloadWhenReadyChange={setReloadWhenReady}
          />
        </Group>
      </AppShell.Header>

      <AppShell.Main>
        {isLoading ? (
          <Center p="xl">
            <Loader />
          </Center>
        ) : error ? (
          <Alert color="red" title="Failed to load tabs">
            {String(error)}
          </Alert>
        ) : tabs.length === 0 ? (
          <Text c="dimmed">No tabs yet — a refresh may be in progress. This view updates when it finishes.</Text>
        ) : (
          <Tabs value={current} onChange={handleTabChange} keepMounted={false}>
            <Tabs.List>
              {tabs.map((t) => (
                <Tabs.Tab key={t.index} value={t.name}>
                  {t.name}
                </Tabs.Tab>
              ))}
            </Tabs.List>
            {tabs.map((t) => (
              <Tabs.Panel key={t.index} value={t.name} pt="md">
                <TabPanel index={t.index} />
              </Tabs.Panel>
            ))}
          </Tabs>
        )}
      </AppShell.Main>
    </AppShell>
  );
}
