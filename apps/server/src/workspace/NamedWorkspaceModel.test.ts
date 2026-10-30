import { expect, it } from "@effect/vitest";
import { CommandId, NamedWorkspaceId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Result from "effect/Result";

import { planWorkspaceChange, type WorkspaceRecord } from "./NamedWorkspaceModel.ts";

const now = "2026-10-29T12:00:00.000Z";
const checkout = {
  projectId: ProjectId.make("project:api"),
  path: "/worktrees/api-account",
  branch: "feature/account",
  headCommit: "abc123",
};
const makeWorkspace = (id: string): WorkspaceRecord => ({
  id: NamedWorkspaceId.make(id),
  name: id,
  version: 0,
  status: "active",
  checkouts: [],
  threadPlacements: [],
  associationChoices: [],
  retainedCheckoutPaths: [],
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  lastError: null,
  archivedThreadIds: [],
  operationId: null,
});

it("keeps ownership exclusive across active and archived workspaces", () => {
  const first = { ...makeWorkspace("first"), checkouts: [checkout] };
  const second = makeWorkspace("second");
  for (const status of ["active", "archived"] as const) {
    const result = planWorkspaceChange({
      workspaces: [{ ...first, status }, second],
      workspaceId: second.id,
      change: { type: "attach", checkout },
      now,
    });
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure.reason).toBe("conflict");
  }
  const attached = planWorkspaceChange({
    workspaces: [first, second],
    workspaceId: second.id,
    change: {
      type: "attach",
      checkout: { ...checkout, path: "/worktrees/api-main", branch: "main" },
    },
    now,
  });
  expect(Result.isSuccess(attached)).toBe(true);
  const nested = planWorkspaceChange({
    workspaces: [first, second],
    workspaceId: second.id,
    change: { type: "attach", checkout: { ...checkout, path: `${checkout.path}/nested` } },
    now,
  });
  expect(Result.isFailure(nested)).toBe(true);
});

it("retains checkout identity and archived thread ownership through retry and restore", () => {
  const threadId = ThreadId.make("thread:account");
  const savedPlacement = { threadId, pinnedAt: now, pinOrderKey: "a", activeOrderKey: "b" };
  const workspace = {
    ...makeWorkspace("account"),
    checkouts: [checkout],
    threadPlacements: [savedPlacement],
  };
  const requested = planWorkspaceChange({
    workspaces: [workspace],
    workspaceId: workspace.id,
    now,
    change: {
      type: "archive-start",
      operationId: CommandId.make("archive"),
      checkouts: [checkout],
      threadIds: [threadId],
    },
  });
  expect(Result.isSuccess(requested)).toBe(true);
  if (Result.isFailure(requested)) return;
  expect(requested.success).toMatchObject({ status: "archiving", archivedThreadIds: [threadId] });
  const failed = planWorkspaceChange({
    workspaces: [requested.success],
    workspaceId: workspace.id,
    now,
    change: { type: "failed", message: "A worktree could not be removed. Retry archive." },
  });
  if (Result.isFailure(failed)) throw failed.failure;
  expect(failed.success.status).toBe("archiving");
  const archived = planWorkspaceChange({
    workspaces: [failed.success],
    workspaceId: workspace.id,
    now,
    change: { type: "archive-complete" },
  });
  if (Result.isFailure(archived)) throw archived.failure;
  expect(archived.success).toMatchObject({
    status: "archived",
    checkouts: [checkout],
    lastError: null,
  });
  const restoring = planWorkspaceChange({
    workspaces: [archived.success],
    workspaceId: workspace.id,
    now,
    change: { type: "restore-start", operationId: CommandId.make("restore") },
  });
  if (Result.isFailure(restoring)) throw restoring.failure;
  const restored = planWorkspaceChange({
    workspaces: [restoring.success],
    workspaceId: workspace.id,
    now,
    change: { type: "restore-complete" },
  });
  if (Result.isFailure(restored)) throw restored.failure;
  expect(restored.success).toMatchObject({
    status: "active",
    checkouts: [checkout],
    threadPlacements: [savedPlacement],
    archivedAt: null,
    archivedThreadIds: [],
  });
  expect(restored.success.version).toBe(5);
  const released = planWorkspaceChange({
    workspaces: [archived.success],
    workspaceId: workspace.id,
    now,
    change: { type: "detach", path: checkout.path },
  });
  expect(released).toMatchObject({
    _tag: "Success",
    success: {
      status: "archived",
      checkouts: [],
      threadPlacements: [savedPlacement],
      archivedThreadIds: [threadId],
    },
  });
});

it("refuses membership changes while cleanup or restoration owns the checkout", () => {
  for (const status of ["archiving", "restoring"] as const) {
    const workspace = { ...makeWorkspace("account"), status, checkouts: [checkout] };
    for (const change of [
      { type: "attach", checkout },
      { type: "detach", path: checkout.path },
      { type: "rename", name: "Other" },
    ] as const) {
      const result = planWorkspaceChange({
        workspaces: [workspace],
        workspaceId: workspace.id,
        change,
        now,
      });
      expect(Result.isFailure(result)).toBe(true);
    }
  }
});

it("keeps pin and ordering mutations confined to their workspace and rejects stale reorders", () => {
  const first = makeWorkspace("first");
  const second = makeWorkspace("second");
  const threadId = ThreadId.make("thread");
  const pin = {
    type: "pin-thread" as const,
    threadId,
    orderKey: "a",
    workspaceId: first.id,
    commandId: CommandId.make("pin"),
  };
  const result = planWorkspaceChange({
    workspaces: [first, second],
    workspaceId: first.id,
    change: pin,
    now,
  });
  if (Result.isFailure(result)) throw result.failure;
  expect(result.success.threadPlacements).toEqual([
    { threadId, pinnedAt: now, pinOrderKey: "a", activeOrderKey: null },
  ]);
  expect(second.threadPlacements).toEqual([]);
  const unpinned = planWorkspaceChange({
    workspaces: [result.success, second],
    workspaceId: first.id,
    change: { ...pin, type: "unpin-thread" },
    now,
  });
  if (Result.isFailure(unpinned)) throw unpinned.failure;
  expect(
    planWorkspaceChange({
      workspaces: [unpinned.success],
      workspaceId: first.id,
      change: { ...pin, type: "reorder-pinned-thread", orderKey: "b" },
      now,
    }),
  ).toMatchObject({ _tag: "Failure", failure: { reason: "conflict" } });
  expect(
    planWorkspaceChange({
      workspaces: [{ ...result.success, status: "archived" }],
      workspaceId: first.id,
      change: pin,
      now,
    }),
  ).toMatchObject({ _tag: "Failure", failure: { reason: "blocked" } });
});
