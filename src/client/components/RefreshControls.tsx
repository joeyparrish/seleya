import { useEffect, useRef } from "react";
import { Button, Checkbox, Group, Loader, Menu, Text, Tooltip } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRefreshStatus, postRefresh } from "../api";

export function RefreshControls({
  reloadWhenReady,
  onReloadWhenReadyChange,
}: {
  reloadWhenReady: boolean;
  onReloadWhenReadyChange: (value: boolean) => void;
}) {
  const qc = useQueryClient();

  const { data: status } = useQuery({
    queryKey: ["refreshStatus"],
    queryFn: getRefreshStatus,
    refetchInterval: (query) => (query.state.data?.running ? 1500 : false),
  });

  // When a refresh transitions running -> idle, the tab list may have changed;
  // refetch it. If the user opted in, also refetch the visible tab data.
  const wasRunning = useRef(false);
  useEffect(() => {
    const running = status?.running ?? false;
    if (wasRunning.current && !running) {
      void qc.invalidateQueries({ queryKey: ["tabs"] });
      if (reloadWhenReady) void qc.invalidateQueries({ queryKey: ["tab"] });
    }
    wasRunning.current = running;
  }, [status?.running, reloadWhenReady, qc]);

  const refresh = useMutation({
    mutationFn: (deep: boolean) => postRefresh(deep),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["refreshStatus"] }),
  });

  const running = status?.running ?? false;
  const statusText = running
    ? `${status?.deep ? "Deep refreshing" : "Refreshing"} ${status?.completed}/${status?.total}…`
    : status?.lastError
      ? "Last refresh failed"
      : status?.finishedAt
        ? `Updated ${new Date(status.finishedAt).toLocaleTimeString()}`
        : null;

  // On narrow screens collapse everything behind a single menu so the fixed
  // header stays one row.
  const wide = useMediaQuery("(min-width: 48em)", false, { getInitialValueInEffect: false });

  if (!wide) {
    return (
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <Button size="xs" variant="light" leftSection={running ? <Loader size="xs" /> : undefined}>
            Refresh
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          {statusText ? <Menu.Label>{statusText}</Menu.Label> : null}
          <Menu.Item
            closeMenuOnClick={false}
            onClick={() => onReloadWhenReadyChange(!reloadWhenReady)}
          >
            {reloadWhenReady ? "☑ " : "☐ "}Reload when ready
          </Menu.Item>
          <Menu.Divider />
          <Menu.Item disabled={running} onClick={() => refresh.mutate(false)}>
            Refresh now
          </Menu.Item>
          <Menu.Item disabled={running} onClick={() => refresh.mutate(true)}>
            Deep refresh
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    );
  }

  return (
    <Group gap="sm" wrap="nowrap">
      {running ? (
        <Group gap="xs" wrap="nowrap">
          <Loader size="xs" />
          <Text size="sm">{statusText}</Text>
        </Group>
      ) : status?.lastError ? (
        <Tooltip label={status.lastError}>
          <Text size="sm" c="red">
            Last refresh failed
          </Text>
        </Tooltip>
      ) : statusText ? (
        <Text size="sm" c="dimmed">
          {statusText}
        </Text>
      ) : null}

      <Checkbox
        size="sm"
        label="Reload when ready"
        checked={reloadWhenReady}
        onChange={(e) => onReloadWhenReadyChange(e.currentTarget.checked)}
      />
      <Button size="xs" variant="light" disabled={running} onClick={() => refresh.mutate(false)}>
        Refresh now
      </Button>
      <Tooltip label="Re-sync everything and reconcile deletions/archived repos">
        <Button size="xs" variant="default" disabled={running} onClick={() => refresh.mutate(true)}>
          Deep refresh
        </Button>
      </Tooltip>
    </Group>
  );
}
