import { useEffect, useRef } from "react";
import { Button, Checkbox, Group, Loader, Text, Tooltip } from "@mantine/core";
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

  return (
    <Group gap="sm">
      {status?.running ? (
        <Group gap="xs">
          <Loader size="xs" />
          <Text size="sm">
            {status.deep ? "Deep refreshing" : "Refreshing"} {status.completed}/{status.total}…
          </Text>
        </Group>
      ) : status?.lastError ? (
        <Tooltip label={status.lastError}>
          <Text size="sm" c="red">
            Last refresh failed
          </Text>
        </Tooltip>
      ) : status?.finishedAt ? (
        <Text size="sm" c="dimmed">
          Updated {new Date(status.finishedAt).toLocaleTimeString()}
        </Text>
      ) : null}

      <Checkbox
        size="sm"
        label="Reload when ready"
        checked={reloadWhenReady}
        onChange={(e) => onReloadWhenReadyChange(e.currentTarget.checked)}
      />
      <Button size="xs" variant="light" disabled={status?.running} onClick={() => refresh.mutate(false)}>
        Refresh now
      </Button>
      <Tooltip label="Re-sync everything and reconcile deletions/archived repos">
        <Button size="xs" variant="default" disabled={status?.running} onClick={() => refresh.mutate(true)}>
          Deep refresh
        </Button>
      </Tooltip>
    </Group>
  );
}
