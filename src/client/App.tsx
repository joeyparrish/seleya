import { AppShell, Title } from "@mantine/core";

export function App() {
  return (
    <AppShell header={{ height: 56 }} padding="md">
      <AppShell.Header>
        <Title order={3} p="sm">
          Seleya
        </Title>
      </AppShell.Header>
      <AppShell.Main>Loading…</AppShell.Main>
    </AppShell>
  );
}
