import { useState } from "react";
import { Alert, AppShell, Center, Group, Loader, Tabs, Text, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { getTabs } from "./api";
import { TabPanel } from "./components/TabPanel";
import { RefreshControls } from "./components/RefreshControls";

export function App() {
  const { data, isLoading, error } = useQuery({ queryKey: ["tabs"], queryFn: getTabs });
  const [reloadWhenReady, setReloadWhenReady] = useState(false);
  const [active, setActive] = useState<string | null>(null);

  const tabs = data?.tabs ?? [];
  const current = active ?? (tabs[0] ? String(tabs[0].index) : null);

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
          <Tabs value={current} onChange={setActive} keepMounted={false}>
            <Tabs.List>
              {tabs.map((t) => (
                <Tabs.Tab key={t.index} value={String(t.index)}>
                  {t.name}
                </Tabs.Tab>
              ))}
            </Tabs.List>
            {tabs.map((t) => (
              <Tabs.Panel key={t.index} value={String(t.index)} pt="md">
                <TabPanel index={t.index} />
              </Tabs.Panel>
            ))}
          </Tabs>
        )}
      </AppShell.Main>
    </AppShell>
  );
}
