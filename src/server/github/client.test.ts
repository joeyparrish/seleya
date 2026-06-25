import { describe, it, expect, vi } from "vitest";
import { createGitHubClient, type GraphQLRequest } from "./client.js";

describe("GitHubClient", () => {
  it("lists org repos across pages", async () => {
    const pages = [
      {
        organization: {
          repositories: {
            nodes: [{ id: "R_1", name: "a", isFork: false, isArchived: false, owner: { login: "org" } }],
            pageInfo: { hasNextPage: true, endCursor: "c1" },
          },
        },
      },
      {
        organization: {
          repositories: {
            nodes: [{ id: "R_2", name: "b", isFork: true, isArchived: false, owner: { login: "org" } }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ];
    const request = vi.fn(async (_q: string, vars?: any) =>
      vars?.cursor == null ? pages[0] : pages[1],
    ) as unknown as GraphQLRequest;

    const client = createGitHubClient(request);
    const repos = await client.listOrgRepos("org");
    expect(repos).toEqual([
      { id: "R_1", owner: "org", name: "a", isFork: false, isArchived: false },
      { id: "R_2", owner: "org", name: "b", isFork: true, isArchived: false },
    ]);
  });

  it("normalizes issues with type and field values and stops at `since`", async () => {
    const issuesPayload = {
      repository: {
        issues: {
          nodes: [
            {
              id: "I_2",
              number: 2,
              title: "new",
              state: "OPEN",
              createdAt: "2026-01-03T00:00:00Z",
              updatedAt: "2026-01-03T00:00:00Z",
              author: { login: "alice" },
              assignees: { nodes: [{ login: "bob" }] },
              labels: { nodes: [{ name: "bug" }] },
              milestone: { title: "v1" },
              comments: { totalCount: 2 },
              issueType: { id: "IT_1", name: "Bug" },
              issueFieldValues: {
                nodes: [
                  {
                    __typename: "IssueFieldSingleSelectValue",
                    ssValue: "High",
                    optionId: "IFSSO_1",
                    field: { name: "Priority" },
                  },
                ],
              },
            },
            {
              id: "I_1",
              number: 1,
              title: "old",
              state: "OPEN",
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
              author: { login: "alice" },
              assignees: { nodes: [] },
              labels: { nodes: [] },
              milestone: null,
              comments: { totalCount: 0 },
              issueType: null,
              issueFieldValues: { nodes: [] },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    };
    const prPayload = {
      repository: {
        pullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      },
    };
    const request = vi.fn(async (q: string) =>
      q.includes("pullRequests") ? prPayload : issuesPayload,
    ) as unknown as GraphQLRequest;

    const client = createGitHubClient(request);
    const issues = await client.fetchIssuesUpdatedSince("o", "n", "2026-01-02T00:00:00Z");

    expect(issues.map((i) => i.id)).toEqual(["I_2"]); // I_1 is at/under `since`
    expect(issues[0].issueType).toEqual({ id: "IT_1", name: "Bug" });
    expect(issues[0].fieldValues).toEqual([
      { fieldName: "Priority", dataType: "single_select", valueText: "High", optionId: "IFSSO_1" },
    ]);
    expect(issues[0].labels).toEqual(["bug"]);
    expect(issues[0].assignees).toEqual(["bob"]);
  });

  it("fetches a single repo by owner/name, returning null when absent", async () => {
    const present = vi.fn(async () => ({
      repository: { id: "R_9", name: "foo", isFork: false, isArchived: false, owner: { login: "acme" } },
    })) as unknown as GraphQLRequest;
    const client = createGitHubClient(present);
    expect(await client.getRepo("acme", "foo")).toEqual({
      id: "R_9",
      owner: "acme",
      name: "foo",
      isFork: false,
      isArchived: false,
    });

    const absent = vi.fn(async () => ({ repository: null })) as unknown as GraphQLRequest;
    expect(await createGitHubClient(absent).getRepo("acme", "ghost")).toBeNull();
  });

  it("discovers fields with options", async () => {
    const payload = {
      repository: {
        issueFields: {
          nodes: [
            {
              __typename: "IssueFieldSingleSelect",
              id: "IFSS_1",
              name: "Priority",
              dataType: "SINGLE_SELECT",
              options: [{ id: "IFSSO_1", name: "High", color: "RED", description: null }],
            },
            { __typename: "IssueFieldNumber", id: "IFN_1", name: "Effort", dataType: "NUMBER" },
          ],
        },
      },
    };
    const request = vi.fn(async () => payload) as unknown as GraphQLRequest;
    const client = createGitHubClient(request);
    const fields = await client.discoverFields("o", "n");
    expect(fields).toEqual([
      {
        id: "IFSS_1",
        name: "Priority",
        dataType: "single_select",
        options: [{ id: "IFSSO_1", name: "High", color: "RED", position: 0 }],
      },
      { id: "IFN_1", name: "Effort", dataType: "number", options: [] },
    ]);
  });
});
