import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Store from "./NamedWorkspaceStore.ts";
import { resolveThreadSpaceId } from "@t3tools/shared/threadSpace";
import { type NamedWorkspaceId, NamedWorkspaceError } from "@t3tools/contracts";
import { withNamedSpaceLease, withWorkspaceLease } from "./workspaceLease.ts";

export const layerCommands = Layer.effect(
  Orchestrator.OrchestratorV2,
  Effect.gen(function* () {
    const base = yield* Orchestrator.OrchestratorV2;
    const store = yield* Store.NamedWorkspaceStore;
    const path = yield* Path.Path;
    return Orchestrator.OrchestratorV2.of({
      ...base,
      dispatch: Effect.fn("NamedWorkspaceGuards.dispatch")(function* (command) {
        const checkouts: string[] = [];
        const spaceIds = new Set<NamedWorkspaceId>();
        let observedThreadId: import("@t3tools/contracts").ThreadId | null = null;
        const catalog = yield* store.list;
        const addSpace = (thread: {
          readonly spaceId?: NamedWorkspaceId | null | undefined;
          readonly worktreePath: string | null;
        }) => {
          const id = resolveThreadSpaceId(thread, catalog);
          if (id) spaceIds.add(id);
        };

        if (command.type === "thread.create") {
          if (command.worktreePath) checkouts.push(command.worktreePath);
          addSpace(command);
        } else if (
          command.type === "message.dispatch" ||
          command.type === "thread.fork" ||
          command.type === "thread.unarchive" ||
          command.type === "checkpoint.rollback" ||
          (command.type === "thread.metadata.update" &&
            (command.worktreePath !== undefined ||
              command.branch !== undefined ||
              command.spaceId !== undefined))
        ) {
          const threadId =
            command.type === "thread.fork" ? command.sourceThreadId : command.threadId;
          observedThreadId = threadId;
          const shell = yield* base.getThreadShell(threadId);
          if (shell) addSpace(shell);
          if (shell?.worktreePath) checkouts.push(shell.worktreePath);
          if (command.type === "thread.metadata.update" && command.spaceId)
            spaceIds.add(command.spaceId);
          if (command.type === "thread.metadata.update" && command.worktreePath)
            checkouts.push(command.worktreePath);
        }
        const operation = Effect.gen(function* () {
          if (observedThreadId !== null) {
            const latest = yield* base.getThreadShell(observedThreadId);
            const current = latest ? resolveThreadSpaceId(latest, yield* store.list) : null;
            if (current !== null && !spaceIds.has(current))
              return yield* new NamedWorkspaceError({
                reason: "conflict",
                message: "The thread changed Space. Try again.",
              });
          }
          for (const id of spaceIds) {
            const space = yield* store.get(id);
            if (space.status !== "active")
              return yield* new NamedWorkspaceError({
                reason: "blocked",
                workspaceId: id,
                message: "Restore this Space before changing its threads.",
              });
          }
          yield* Effect.forEach(checkouts, (checkout) =>
            store.assertAvailable(path.resolve(checkout)),
          );
        }).pipe(
          Effect.mapError(
            (cause) =>
              new Orchestrator.OrchestratorCommandRejectedError({
                commandId: command.commandId,
                commandType: command.type,
                cause,
              }),
          ),
          Effect.andThen(base.dispatch(command)),
        );
        const checkoutOperation = [...new Set(checkouts.map((checkout) => path.resolve(checkout)))]
          .toSorted()
          .reduceRight((effect, checkout) => withWorkspaceLease(checkout, effect), operation);
        return yield* [...spaceIds]
          .toSorted()
          .reduceRight((effect, id) => withNamedSpaceLease(id, effect), checkoutOperation);
      }),
    });
  }),
);
