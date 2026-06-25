import { Accordion, Badge, Group, Text } from "@mantine/core";
import type { GroupView } from "../types";
import { IssueTable } from "./IssueTable";

export function GroupSection({ group }: { group: GroupView }) {
  return (
    <Accordion.Item value={group.name}>
      <Accordion.Control>
        <Group gap="sm">
          <Text fw={600}>{group.name}</Text>
          <Badge variant="light">{group.issues.length}</Badge>
        </Group>
      </Accordion.Control>
      <Accordion.Panel>
        {group.issues.length === 0 ? (
          <Text c="dimmed" size="sm">
            No matching issues
          </Text>
        ) : (
          <IssueTable issues={group.issues} />
        )}
      </Accordion.Panel>
    </Accordion.Item>
  );
}
