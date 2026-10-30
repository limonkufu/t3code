import {
  NamedWorkspaceError,
  type CommandId,
  type NamedWorkspace,
  type NamedWorkspaceCheckout,
  type NamedWorkspaceId,
  type NamedWorkspaceMutation,
  type ThreadId,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import { normalizeProjectPathForComparison as pathKey } from "@t3tools/shared/path";

export interface WorkspaceRecord extends NamedWorkspace {
  readonly archivedThreadIds: readonly ThreadId[];
  readonly operationId: CommandId | null;
}

export type WorkspaceChange =
  | { readonly type: "create"; readonly name: string }
  | { readonly type: "rename"; readonly name: string }
  | {
      readonly type: "attach";
      readonly checkout: NamedWorkspaceCheckout;
      readonly remember?: boolean;
    }
  | { readonly type: "detach"; readonly path: string }
  | Extract<NamedWorkspaceMutation, { readonly type: "set-project-association" }>
  | Extract<NamedWorkspaceMutation, { readonly threadId: ThreadId }>
  | {
      readonly type: "archive-start";
      readonly checkouts: readonly NamedWorkspaceCheckout[];
      readonly threadIds: readonly ThreadId[];
      readonly operationId: CommandId;
      readonly retainedCheckoutPaths?: readonly string[];
      readonly cleanup?: boolean;
    }
  | { readonly type: "archive-complete" }
  | { readonly type: "restore-start"; readonly operationId: CommandId }
  | { readonly type: "restore-complete" }
  | { readonly type: "failed"; readonly message: string };

export function planWorkspaceChange(input: {
  readonly workspaces: readonly WorkspaceRecord[];
  readonly workspaceId: NamedWorkspaceId;
  readonly change: WorkspaceChange;
  readonly now: string;
}): Result.Result<WorkspaceRecord, NamedWorkspaceError> {
  const { workspaceId, change, now } = input;
  const existing = input.workspaces.find((workspace) => workspace.id === workspaceId);
  const fail = (reason: NamedWorkspaceError["reason"], message: string) =>
    Result.fail(new NamedWorkspaceError({ reason, workspaceId, message }));
  if (change.type === "create") {
    if (existing) return fail("conflict", "This workspace already exists.");
    return Result.succeed({
      id: workspaceId,
      name: change.name,
      version: 0,
      status: "active",
      checkouts: [],
      retainedCheckoutPaths: [],
      associationChoices: [],
      threadPlacements: [],
      archivedThreadIds: [],
      operationId: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      lastError: null,
    });
  }
  if (!existing) return fail("not_found", "This workspace is unavailable.");
  const next = { ...existing, version: existing.version + 1, updatedAt: now };
  switch (change.type) {
    case "set-project-association":
      if (existing.status !== "active" && existing.status !== "archived")
        return fail("blocked", "Wait for the workspace operation to finish.");
      return Result.succeed({
        ...next,
        associationChoices: [
          ...existing.associationChoices.filter((item) => item.projectId !== change.projectId),
          ...(change.choice === null
            ? []
            : [{ projectId: change.projectId, choice: change.choice }]),
        ],
      });
    case "pin-thread":
    case "unpin-thread":
    case "reorder-pinned-thread":
    case "reorder-active-thread": {
      if (existing.status !== "active")
        return fail("blocked", "Restore the workspace before arranging its threads.");
      const previous = existing.threadPlacements.find((item) => item.threadId === change.threadId);
      const placement = previous ?? {
        threadId: change.threadId,
        pinnedAt: null,
        pinOrderKey: null,
        activeOrderKey: null,
      };
      if (change.type === "reorder-pinned-thread" && placement.pinnedAt === null)
        return fail("conflict", "This thread is no longer pinned in this workspace.");
      if (change.type === "reorder-active-thread" && placement.pinnedAt !== null)
        return fail(
          "conflict",
          "Unpin the thread in this workspace before reordering it in Active.",
        );
      const updated =
        change.type === "pin-thread"
          ? {
              ...placement,
              pinnedAt: placement.pinnedAt ?? now,
              pinOrderKey:
                placement.pinnedAt === null ? (change.orderKey ?? null) : placement.pinOrderKey,
            }
          : change.type === "unpin-thread"
            ? { ...placement, pinnedAt: null, pinOrderKey: null }
            : change.type === "reorder-pinned-thread"
              ? { ...placement, pinOrderKey: change.orderKey }
              : { ...placement, activeOrderKey: change.orderKey };
      return Result.succeed({
        ...next,
        threadPlacements: [
          ...existing.threadPlacements.filter((item) => item.threadId !== change.threadId),
          updated,
        ],
      });
    }
    case "rename":
      if (existing.status !== "active" && existing.status !== "archived")
        return fail("blocked", "Wait for the workspace operation to finish.");
      return Result.succeed({ ...next, name: change.name });
    case "attach": {
      if (existing.status !== "active")
        return fail("blocked", "Restore the workspace before adding a checkout.");
      const target = pathKey(change.checkout.path);
      const overlaps = input.workspaces.some((workspace) =>
        workspace.checkouts.some((checkout) => {
          const other = pathKey(checkout.path);
          if (other === target) return false;
          const separator = other.includes("\\") ? "\\" : "/";
          return (
            target.startsWith(`${other}${separator}`) || other.startsWith(`${target}${separator}`)
          );
        }),
      );
      if (overlaps) return fail("conflict", "Workspace checkouts cannot contain one another.");
      const owner = input.workspaces.find((workspace) =>
        workspace.checkouts.some(
          (checkout) => pathKey(checkout.path) === pathKey(change.checkout.path),
        ),
      );
      if (owner && owner.id !== workspaceId)
        return fail("conflict", "This checkout belongs to another workspace.");
      const previous = existing.checkouts.find(
        (checkout) => pathKey(checkout.path) === pathKey(change.checkout.path),
      );
      if (previous && previous.projectId !== change.checkout.projectId)
        return fail("conflict", "This checkout belongs to another project.");
      return Result.succeed({
        ...next,
        associationChoices: change.remember
          ? [
              ...existing.associationChoices.filter(
                (item) => item.projectId !== change.checkout.projectId,
              ),
              { projectId: change.checkout.projectId, choice: "add" },
            ]
          : existing.associationChoices,
        checkouts: [
          ...existing.checkouts.filter(
            (checkout) => pathKey(checkout.path) !== pathKey(change.checkout.path),
          ),
          change.checkout,
        ],
      });
    }
    case "detach":
      if (
        existing.status !== "active" &&
        existing.status !== "archived" &&
        existing.lastError === null
      )
        return fail(
          "blocked",
          "Wait for the workspace operation to finish before removing a checkout.",
        );
      return Result.succeed({
        ...next,
        checkouts: existing.checkouts.filter(
          (checkout) => pathKey(checkout.path) !== pathKey(change.path),
        ),
      });
    case "archive-start":
      if (existing.status !== "active" && !(change.cleanup && existing.status === "archived"))
        return fail("blocked", "This Space is already being archived or is archived.");
      return Result.succeed({
        ...next,
        status: "archiving",
        checkouts: change.checkouts,
        archivedThreadIds: change.threadIds,
        retainedCheckoutPaths: change.retainedCheckoutPaths ?? [],
        operationId: change.operationId,
        lastError: null,
      });
    case "archive-complete":
      if (existing.status !== "archiving")
        return fail("blocked", "This workspace is not being archived.");
      return Result.succeed({ ...next, status: "archived", archivedAt: now, lastError: null });
    case "restore-start":
      if (existing.status !== "archived" && existing.status !== "archiving")
        return fail("blocked", "This workspace is not archived.");
      return Result.succeed({
        ...next,
        status: "restoring",
        operationId: change.operationId,
        lastError: null,
      });
    case "restore-complete":
      if (existing.status !== "restoring")
        return fail("blocked", "This workspace is not being restored.");
      return Result.succeed({
        ...next,
        status: "active",
        archivedAt: null,
        archivedThreadIds: [],
        operationId: null,
        lastError: null,
      });
    case "failed":
      if (existing.status !== "archiving" && existing.status !== "restoring")
        return fail("blocked", "No workspace operation is pending.");
      return Result.succeed({ ...next, lastError: change.message });
  }
}
