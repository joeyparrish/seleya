import { useMemo, useState } from "react";
import { Anchor, Badge, Group, Table, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from "@tanstack/react-table";
import type { IssueView } from "../types";

const col = createColumnHelper<IssueView>();

function ageDays(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

// GitHub option color names -> Mantine theme colors.
const COLOR_MAP: Record<string, string> = {
  RED: "red",
  ORANGE: "orange",
  YELLOW: "yellow",
  GREEN: "green",
  BLUE: "blue",
  PURPLE: "grape",
  PINK: "pink",
  GRAY: "gray",
};

function mantineColor(c?: string | null): string {
  return c ? (COLOR_MAP[c.toUpperCase()] ?? "gray") : "gray";
}

// GitHub label colors are raw 6-hex strings (no leading "#"), unlike the named
// colors used by issue types and fields. Render them directly so labels match
// GitHub; autoContrast picks readable text. Missing color falls back to gray.
function labelColor(hex: string | null): string {
  return hex ? `#${hex}` : "gray";
}

export function IssueTable({ issues }: { issues: IssueView[] }) {
  const [sorting, setSorting] = useState<SortingState>([]);

  // Progressively reveal columns as the screen widens; Repo and Title always show.
  const opts = { getInitialValueInEffect: false };
  const sm = useMediaQuery("(min-width: 48em)", false, opts);
  const md = useMediaQuery("(min-width: 62em)", false, opts);
  const lg = useMediaQuery("(min-width: 75em)", false, opts);
  const columnVisibility = useMemo(
    () => ({
      issueTypeName: sm,
      fields: sm,
      labels: md,
      assignees: md,
      isPullRequest: lg,
      createdAt: lg,
      comments: lg,
    }),
    [sm, md, lg],
  );

  const columns = useMemo(
    () => [
      col.accessor("isPullRequest", {
        header: "Type",
        cell: (c) => (
          <Badge size="xs" variant="light" color={c.getValue() ? "violet" : "blue"}>
            {c.getValue() ? "PR" : "Issue"}
          </Badge>
        ),
      }),
      col.accessor("repo", {
        header: "Repo",
        cell: (c) => (
          <Text size="xs" c="dimmed">
            {c.getValue()}
          </Text>
        ),
      }),
      col.accessor("title", {
        header: "Title",
        cell: (c) => (
          <Anchor href={c.row.original.url} target="_blank" size="sm">
            #{c.row.original.number} {c.getValue()}
          </Anchor>
        ),
      }),
      col.accessor("issueTypeName", {
        header: "Issue Type",
        cell: (c) =>
          c.getValue() ? (
            <Badge size="xs" variant="outline" color={mantineColor(c.row.original.issueTypeColor)}>
              {c.getValue()}
            </Badge>
          ) : null,
      }),
      col.display({
        id: "labels",
        header: "Labels",
        cell: (c) => (
          <Group gap={4}>
            {c.row.original.labels.map((l) => (
              <Badge key={l.name} size="xs" variant="filled" color={labelColor(l.color)} autoContrast>
                {l.name}
              </Badge>
            ))}
          </Group>
        ),
      }),
      col.display({
        id: "fields",
        header: "Fields",
        cell: (c) => (
          <Group gap={4}>
            {c.row.original.fields.map((f, i) => (
              <Badge key={`${f.name}-${i}`} size="xs" color={mantineColor(f.optionColor)}>
                {f.name}: {String(f.value)}
              </Badge>
            ))}
          </Group>
        ),
      }),
      col.accessor((r) => r.assignees.join(", "), {
        id: "assignees",
        header: "Assignees",
        cell: (c) => <Text size="xs">{c.getValue()}</Text>,
      }),
      col.accessor("createdAt", {
        header: "Age",
        cell: (c) => <Text size="xs">{ageDays(c.getValue())}d</Text>,
      }),
      col.accessor("comments", {
        header: "Comments",
        cell: (c) => <Text size="xs">{c.getValue()}</Text>,
      }),
    ],
    [],
  );

  const table = useReactTable({
    data: issues,
    columns,
    state: { sorting, columnVisibility },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <Table.ScrollContainer minWidth={0}>
      <Table striped highlightOnHover stickyHeader verticalSpacing="xs">
      <Table.Thead>
        {table.getHeaderGroups().map((hg) => (
          <Table.Tr key={hg.id}>
            {hg.headers.map((h) => (
              <Table.Th
                key={h.id}
                onClick={h.column.getToggleSortingHandler()}
                style={{ cursor: h.column.getCanSort() ? "pointer" : "default", whiteSpace: "nowrap" }}
              >
                {flexRender(h.column.columnDef.header, h.getContext())}
                {{ asc: " ▲", desc: " ▼" }[h.column.getIsSorted() as string] ?? ""}
              </Table.Th>
            ))}
          </Table.Tr>
        ))}
      </Table.Thead>
      <Table.Tbody>
        {table.getRowModel().rows.map((row) => (
          <Table.Tr key={row.id}>
            {row.getVisibleCells().map((cell) => (
              <Table.Td key={cell.id}>
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </Table.Td>
            ))}
          </Table.Tr>
        ))}
      </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}
