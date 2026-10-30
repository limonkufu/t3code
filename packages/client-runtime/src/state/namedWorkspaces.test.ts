import { expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  NamedWorkspaceId,
  ProjectId,
  ThreadId,
  type NamedWorkspace,
} from "@t3tools/contracts";
import {
  filterWorkspaceThreads,
  selectSpaceCheckout,
  projectWorkspaceThreadPlacements,
  revealThreadWorkspace,
} from "./namedWorkspaces.ts";

it("scopes checkouts within their environment and keeps All threads inclusive by default", () => {
  const local = EnvironmentId.make("local");
  const remote = EnvironmentId.make("remote");
  const workspace: NamedWorkspace = {
    id: NamedWorkspaceId.make("account"),
    name: "Account",
    version: 0,
    status: "active",
    createdAt: "2026-10-29T12:00:00.000Z",
    updatedAt: "2026-10-29T12:00:00.000Z",
    archivedAt: null,
    lastError: null,
    threadPlacements: [],
    associationChoices: [],
    retainedCheckoutPaths: [],
    checkouts: [
      {
        projectId: ProjectId.make("api"),
        path: "/worktrees/api-feature",
        branch: "feature",
        headCommit: "abc",
      },
      {
        projectId: ProjectId.make("api"),
        path: "/worktrees/api-main",
        branch: "main",
        headCommit: "def",
      },
    ],
  };
  const entries = [{ environmentId: local, workspace }];
  const threads = [
    { id: 1, environmentId: local, worktreePath: "/worktrees/api-feature/", needsAttention: true },
    { id: 2, environmentId: local, worktreePath: "/worktrees/api-main", needsAttention: false },
    { id: 3, environmentId: remote, worktreePath: "/worktrees/api-feature", needsAttention: true },
    { id: 4, environmentId: local, worktreePath: null, needsAttention: true },
  ];
  expect(filterWorkspaceThreads(threads, entries, null, true)).toBe(threads);
  expect(
    filterWorkspaceThreads(
      threads,
      entries,
      { environmentId: local, workspaceId: workspace.id },
      true,
    ).map((thread) => thread.id),
  ).toEqual([1, 2]);
  expect(filterWorkspaceThreads(threads, entries, null, false).map((thread) => thread.id)).toEqual([
    3, 4,
  ]);
  expect(threads.filter((thread) => thread.needsAttention).map((thread) => thread.id)).toEqual([
    1, 3, 4,
  ]);
  expect(
    selectSpaceCheckout(workspace, "/worktrees/api-main", ProjectId.make("different-project")),
  ).toBeNull();
  expect(selectSpaceCheckout(workspace, "/worktrees/api-main", ProjectId.make("api"))?.path).toBe(
    "/worktrees/api-main",
  );
  const scope = { environmentId: local, workspaceId: workspace.id };
  expect(revealThreadWorkspace(threads[0]!, entries, null, true)).toBeNull();
  expect(revealThreadWorkspace(threads[0]!, entries, null, false)).toEqual(scope);
  expect(revealThreadWorkspace(threads[3]!, entries, scope, true)).toBeNull();
  expect(revealThreadWorkspace(threads[2]!, entries, scope, true)).toBeNull();
  const placedThreads = [
    {
      ...threads[0]!,
      id: ThreadId.make("a"),
      pinnedAt: "global-pin",
      pinOrderKey: "global-order",
      activeOrderKey: "global-active",
      settledOverride: "settled",
      snoozedUntil: "future",
    },
    {
      ...threads[1]!,
      id: ThreadId.make("b"),
      pinnedAt: "other-global-pin",
      pinOrderKey: "global-order",
      activeOrderKey: "global-active",
      settledOverride: null,
      snoozedUntil: null,
    },
  ];
  const workspaceEntries = [
    {
      environmentId: local,
      workspace: {
        ...workspace,
        threadPlacements: [
          {
            threadId: ThreadId.make("a"),
            pinnedAt: "workspace-pin",
            pinOrderKey: "workspace-order",
            activeOrderKey: "workspace-active",
          },
        ],
      },
    },
  ];
  expect(projectWorkspaceThreadPlacements(placedThreads, workspaceEntries, null)).toBe(
    placedThreads,
  );
  expect(projectWorkspaceThreadPlacements(placedThreads, workspaceEntries, scope)).toMatchObject([
    {
      pinnedAt: "workspace-pin",
      pinOrderKey: "workspace-order",
      activeOrderKey: "workspace-active",
      settledOverride: "settled",
      snoozedUntil: "future",
    },
    { pinnedAt: null, pinOrderKey: null, activeOrderKey: null },
  ]);
  expect(placedThreads[0]?.pinOrderKey).toBe("global-order");
  const otherSpace = NamedWorkspaceId.make("other");
  const assigned = [
    { ...threads[0]!, spaceId: otherSpace },
    { ...threads[1]!, spaceId: null },
    { ...threads[3]!, spaceId: workspace.id },
  ];
  const assignments = [
    ...entries,
    { environmentId: local, workspace: { ...workspace, id: otherSpace, checkouts: [] } },
  ];
  expect(
    filterWorkspaceThreads(assigned, assignments, scope, true).map((thread) => thread.id),
  ).toEqual([4]);
  expect(
    filterWorkspaceThreads(
      assigned,
      assignments,
      { environmentId: local, workspaceId: otherSpace },
      true,
    ).map((thread) => thread.id),
  ).toEqual([1]);
  expect(
    filterWorkspaceThreads(assigned, assignments, null, false).map((thread) => thread.id),
  ).toEqual([2]);
});
