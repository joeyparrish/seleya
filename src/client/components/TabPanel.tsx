import { Accordion, Alert, Center, Loader } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { getTab } from "../api";
import { GroupSection } from "./GroupSection";

export function TabPanel({ index }: { index: number }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["tab", index],
    queryFn: () => getTab(index),
  });

  if (isLoading) {
    return (
      <Center p="xl">
        <Loader />
      </Center>
    );
  }
  if (error) {
    return (
      <Alert color="red" title="Failed to load tab">
        {String(error)}
      </Alert>
    );
  }
  if (!data) return null;

  return (
    <Accordion multiple defaultValue={data.groups.map((g) => g.name)} variant="separated">
      {data.groups.map((g) => (
        <GroupSection key={g.name} group={g} />
      ))}
    </Accordion>
  );
}
