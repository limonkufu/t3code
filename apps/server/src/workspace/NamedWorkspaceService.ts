import { resolveThreadSpaceId } from "@t3tools/shared/threadSpace";
import {
  CommandId,
  NamedWorkspaceError,
  type NamedWorkspace,
  type NamedWorkspaceArchivePreview,
  type NamedWorkspaceId,
  type NamedWorkspaceMutation,
  type NamedWorkspaceSuggestion,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import type * as Stream from "effect/Stream";

import * as Runtime from "./NamedWorkspaceRuntime.ts";
import * as Store from "./NamedWorkspaceStore.ts";
import { withNamedSpaceLease, withWorkspaceLease } from "./workspaceLease.ts";
import type { WorkspaceRecord } from "./NamedWorkspaceModel.ts";

export class NamedWorkspaceService extends Context.Service<
  NamedWorkspaceService,
  {
    readonly stream: Stream.Stream<readonly NamedWorkspace[]>;
    readonly suggestions: (
      projectId: ProjectId,
    ) => Effect.Effect<readonly NamedWorkspaceSuggestion[], NamedWorkspaceError>;
    readonly previewArchive: (
      id: NamedWorkspaceId,
    ) => Effect.Effect<NamedWorkspaceArchivePreview, NamedWorkspaceError>;
    readonly mutate: (
      input: NamedWorkspaceMutation,
    ) => Effect.Effect<NamedWorkspace, NamedWorkspaceError>;
    readonly recover: Effect.Effect<void>;
  }
>()("t3/workspace/NamedWorkspaceService") {}

const make = Effect.gen(function* () {
  const store = yield* Store.NamedWorkspaceStore;
  const runtime = yield* Runtime.NamedWorkspaceRuntime;
  const lock = yield* Semaphore.make(1);
  const suggestions = Effect.fn("NamedWorkspaceService.suggestions")(function* (
    projectId: ProjectId,
  ) {
    const catalog = yield* store.list;
    const workspaces = catalog.filter(
      (workspace) =>
        workspace.status === "active" &&
        !workspace.checkouts.some((checkout) => checkout.projectId === projectId),
    );
    if (workspaces.length === 0) return [];
    const matches = yield* runtime.matchingBranches(
      projectId,
      workspaces.flatMap((workspace) => workspace.checkouts.map((checkout) => checkout.branch)),
    );
    const available = yield* Effect.filter(matches, (match) => {
      if (
        catalog.some((workspace) =>
          workspace.checkouts.some(
            (checkout) => checkout.projectId === projectId && checkout.branch === match.branch,
          ),
        )
      )
        return Effect.succeed(false);
      return match.path === null
        ? Effect.succeed(true)
        : store.owner(match.path).pipe(Effect.map((owner) => owner === undefined));
    });
    return workspaces.flatMap((workspace) =>
      available
        .filter((match) => workspace.checkouts.some((checkout) => checkout.branch === match.branch))
        .map((match) => ({
          workspaceId: workspace.id,
          branch: match.branch,
          path: match.path,
          choice:
            workspace.associationChoices.find((item) => item.projectId === projectId)?.choice ??
            null,
        })),
    );
  });
  const inspect = Effect.fn("NamedWorkspaceService.inspect")(function* (
    workspace: WorkspaceRecord,
  ) {
    const membership = yield* runtime.members(workspace, yield* store.list);
    const retained =
      workspace.status === "active" || workspace.status === "archived"
        ? membership.retainedCheckoutPaths
        : workspace.retainedCheckoutPaths;
    const checkouts = yield* Effect.forEach(workspace.checkouts, (checkout) =>
      retained.includes(checkout.path)
        ? Effect.succeed({ checkout, exists: true, threadIds: [], blockers: [] })
        : runtime.inspect(checkout, workspace.status !== "active"),
    );
    return { ...membership, checkouts, retainedCheckoutPaths: retained };
  });
  const previewArchive = Effect.fn("NamedWorkspaceService.previewArchive")(function* (
    id: NamedWorkspaceId,
  ) {
    const workspace = yield* store.get(id);
    const inspection = yield* inspect(workspace);
    const inspections = inspection.checkouts;
    return {
      workspaceId: id,
      threadCount: new Set([...workspace.archivedThreadIds, ...inspection.threadIds]).size,
      checkouts: inspections.map(({ checkout, exists, blockers }) => ({
        ...checkout,
        exists,
        retained: inspection.retainedCheckoutPaths.includes(checkout.path),
        blockers,
      })),
    };
  });
  const finish = Effect.fn("NamedWorkspaceService.finish")(function* (workspace: WorkspaceRecord) {
    if (workspace.operationId === null)
      return yield* new NamedWorkspaceError({
        reason: "storage",
        workspaceId: workspace.id,
        message: "The workspace operation has no saved identity.",
      });
    const operationId = workspace.operationId;
    const restoring = workspace.status === "restoring";
    const operation = Effect.gen(function* () {
      const inspection = restoring ? null : yield* inspect(workspace);
      const blocker =
        inspection?.blockers[0] ?? inspection?.checkouts.flatMap((entry) => entry.blockers)[0];
      if (blocker)
        return yield* new NamedWorkspaceError({
          reason: "blocked",
          workspaceId: workspace.id,
          message: blocker.message,
        });
      if (!restoring) yield* runtime.archiveThreads(workspace.archivedThreadIds, operationId);
      for (const checkout of workspace.checkouts) {
        if (workspace.retainedCheckoutPaths.includes(checkout.path)) continue;
        yield* runtime[restoring ? "restore" : "archive"]({
          checkout,
          threadIds: workspace.archivedThreadIds,
          commandId: operationId,
        });
      }
      if (restoring) yield* runtime.restoreThreads(workspace.archivedThreadIds, operationId);
      return yield* store.change({
        commandId: CommandId.make(`${operationId}:complete`),
        workspaceId: workspace.id,
        change: { type: restoring ? "restore-complete" : "archive-complete" },
      });
    });
    return yield* operation.pipe(
      Effect.tapError((error) =>
        store.change({
          commandId: CommandId.make(`${operationId}:failed:${workspace.version}`),
          workspaceId: workspace.id,
          change: { type: "failed", message: error.message },
        }),
      ),
    );
  });
  const mutateUnlocked = Effect.fn("NamedWorkspaceService.mutateUnlocked")(function* (
    input: NamedWorkspaceMutation,
  ) {
    const { commandId, workspaceId } = input;
    if (input.type === "set-project-association")
      return yield* store.change({ commandId, workspaceId, change: input });
    if (input.type === "associate-project") {
      const workspace = yield* store.get(workspaceId);
      if (workspace.status !== "active")
        return yield* new NamedWorkspaceError({
          reason: "blocked",
          workspaceId,
          message: "Restore the workspace before adding a project.",
        });
      if (
        input.automatic &&
        workspace.associationChoices.find((item) => item.projectId === input.projectId)?.choice !==
          "add"
      )
        return yield* new NamedWorkspaceError({
          reason: "conflict",
          workspaceId,
          message: "Review this project's workspace suggestion first.",
        });
      if (workspace.checkouts.some((checkout) => checkout.projectId === input.projectId))
        return workspace;
      if (
        (yield* store.list).some(
          (owner) =>
            owner.id !== workspaceId &&
            owner.checkouts.some(
              (checkout) =>
                checkout.projectId === input.projectId && checkout.branch === input.branch,
            ),
        )
      )
        return yield* new NamedWorkspaceError({
          reason: "conflict",
          workspaceId,
          message:
            "Another workspace owns this project's matching checkout. Remove it there first.",
        });
      if (!workspace.checkouts.some((checkout) => checkout.branch === input.branch))
        return yield* new NamedWorkspaceError({
          reason: "conflict",
          workspaceId,
          message: "This branch no longer matches the workspace.",
        });
      const matches = yield* runtime.matchingBranches(
        input.projectId,
        workspace.checkouts.map((checkout) => checkout.branch),
      );
      const match = matches.find((candidate) => candidate.branch === input.branch);
      if (!match || (input.automatic && matches.length !== 1))
        return yield* new NamedWorkspaceError({
          reason: "conflict",
          workspaceId,
          message: "The matching branch changed or is ambiguous. Review the project and try again.",
        });
      if (match.path !== null && (yield* store.owner(match.path)))
        return yield* new NamedWorkspaceError({
          reason: "conflict",
          workspaceId,
          message: "This checkout belongs to another workspace.",
        });
      const checkout = yield* runtime.checkoutBranch(input.projectId, match);
      return yield* withWorkspaceLease(
        checkout.path,
        Effect.gen(function* () {
          const verified = yield* runtime.adopt(input.projectId, checkout.path);
          if (verified.branch !== input.branch)
            return yield* new NamedWorkspaceError({
              reason: "conflict",
              workspaceId,
              message: "The matching branch changed. Review the project and try again.",
            });
          return yield* store.change({
            commandId,
            workspaceId,
            change: { type: "attach", checkout: verified, remember: input.remember },
          });
        }),
      );
    }
    if (input.type === "create" || input.type === "rename") {
      yield* store.change({
        commandId,
        workspaceId,
        change: { type: input.type, name: input.name },
      });
      return yield* store.get(workspaceId);
    }
    if (input.type === "attach") {
      const checkout = yield* runtime.adopt(input.projectId, input.path);
      return yield* withWorkspaceLease(
        checkout.path,
        Effect.gen(function* () {
          const verified = yield* runtime.adopt(input.projectId, checkout.path);
          yield* store.change({
            commandId,
            workspaceId,
            change: { type: "attach", checkout: verified },
          });
          return yield* store.get(workspaceId);
        }),
      );
    }
    const workspace = yield* store.get(workspaceId);
    if ("threadId" in input) {
      const thread = yield* runtime.threadCheckout(input.threadId);
      if (resolveThreadSpaceId(thread, yield* store.list) !== workspaceId)
        return yield* new NamedWorkspaceError({
          reason: "conflict",
          workspaceId,
          message: "This thread does not belong to this workspace.",
        });
      return yield* store.change({ commandId, workspaceId, change: input });
    }
    if (input.type === "detach")
      return yield* withWorkspaceLease(
        input.path,
        store.change({ commandId, workspaceId, change: { type: "detach", path: input.path } }),
      );
    const lifecycle = Effect.gen(function* () {
      let pending = yield* store.get(workspaceId);
      if (input.type === "archive") {
        if (pending.status === "archived" && pending.retainedCheckoutPaths.length === 0)
          return pending;
        if (pending.status === "restoring")
          return yield* new NamedWorkspaceError({
            reason: "blocked",
            workspaceId,
            message: "Finish restoring this workspace first.",
          });
        if (pending.status === "active" || pending.status === "archived") {
          const inspection = yield* inspect(pending);
          const inspections = inspection.checkouts;
          const blocker =
            inspection.blockers[0] ?? inspections.flatMap((entry) => entry.blockers)[0];
          if (blocker)
            return yield* new NamedWorkspaceError({
              reason: "blocked",
              workspaceId,
              message: blocker.message,
            });
          pending = yield* store.change({
            commandId: CommandId.make(`${commandId}:start`),
            workspaceId,
            change: {
              type: "archive-start",
              operationId: commandId,
              checkouts: inspections.map((entry) => entry.checkout),
              threadIds: [...new Set([...pending.archivedThreadIds, ...inspection.threadIds])],
              cleanup: pending.status === "archived",
              retainedCheckoutPaths: inspection.retainedCheckoutPaths,
            },
          });
        }
      } else {
        if (pending.status === "active") return pending;
        if (pending.status !== "restoring")
          pending = yield* store.change({
            commandId: CommandId.make(`${commandId}:start`),
            workspaceId,
            change: { type: "restore-start", operationId: commandId },
          });
      }
      pending = yield* store.get(workspaceId);
      if (pending.status !== "archiving" && pending.status !== "restoring") return pending;
      return yield* finish(pending);
    });
    return yield* workspace.checkouts
      .map((checkout) => checkout.path)
      .toSorted()
      .reduceRight((effect, path) => withWorkspaceLease(path, effect), lifecycle);
  });
  const mutate = Effect.fn("NamedWorkspaceService.mutate")(function* (
    input: NamedWorkspaceMutation,
  ) {
    return Store.workspaceForClient(
      yield* withNamedSpaceLease(input.workspaceId, lock.withPermit(mutateUnlocked(input))),
    );
  });
  const recover = Effect.gen(function* () {
    for (const workspace of yield* store.list) {
      if (workspace.status !== "archiving" && workspace.status !== "restoring") continue;
      yield* mutate({
        workspaceId: workspace.id,
        commandId: CommandId.make(`workspace:recover:${workspace.id}:${workspace.version}`),
        type: workspace.status === "archiving" ? "archive" : "restore",
      }).pipe(Effect.catch(() => Effect.void));
    }
  });
  return NamedWorkspaceService.of({
    stream: store.stream,
    suggestions,
    previewArchive,
    mutate,
    recover,
  });
});

export const layer = Layer.effect(NamedWorkspaceService, make);
