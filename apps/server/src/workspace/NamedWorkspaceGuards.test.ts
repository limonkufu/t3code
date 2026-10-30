import { expect, it } from "@effect/vitest";
import { CommandId, NamedWorkspaceId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Guards from "./NamedWorkspaceGuards.ts";
import * as Store from "./NamedWorkspaceStore.ts";

it.effect("prevents commands from moving work into or out of an inactive workspace", () =>
  Effect.gen(function* () {
    const stores = yield* Layer.build(Store.layer);
    const store = Context.get(stores, Store.NamedWorkspaceStore);
    const workspaceId = NamedWorkspaceId.make("workspace");
    const path = "/worktrees/account";
    yield* store.change({
      workspaceId,
      commandId: CommandId.make("create"),
      change: { type: "create", name: "Account" },
    });
    yield* store.change({
      workspaceId,
      commandId: CommandId.make("attach"),
      change: {
        type: "attach",
        checkout: {
          projectId: ProjectId.make("project"),
          path,
          branch: "account",
          headCommit: "abc",
        },
      },
    });
    yield* store.change({
      workspaceId,
      commandId: CommandId.make("archive"),
      change: {
        type: "archive-start",
        operationId: CommandId.make("archive"),
        checkouts: (yield* store.get(workspaceId)).checkouts,
        threadIds: [],
      },
    });
    let checkout: string | null = null;
    const guarded = yield* Layer.build(
      Guards.layerCommands.pipe(
        Layer.provide(Layer.succeed(Store.NamedWorkspaceStore, store)),
        Layer.provide(
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadShell: () => Effect.succeed({ worktreePath: checkout } as never),
            dispatch: (command) =>
              Effect.sync(() => {
                if (command.type === "thread.metadata.update" && command.worktreePath !== undefined)
                  checkout = command.worktreePath;
                return { sequence: 1, storedEvents: [] };
              }),
          }),
        ),
      ),
    );
    const engine = Context.get(guarded, Orchestrator.OrchestratorV2);
    const threadId = ThreadId.make("thread");
    expect(
      yield* engine
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("move-in"),
          threadId,
          worktreePath: path,
        })
        .pipe(Effect.result),
    ).toMatchObject({ _tag: "Failure" });
    expect(checkout).toBeNull();
    expect(
      yield* engine
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("space:archived-target"),
          threadId,
          spaceId: workspaceId,
        })
        .pipe(Effect.result),
    ).toMatchObject({ _tag: "Failure" });

    checkout = path;
    expect(
      yield* engine
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("move-out"),
          threadId,
          worktreePath: "/unowned",
        })
        .pipe(Effect.result),
    ).toMatchObject({ _tag: "Failure" });
    expect(checkout).toBe(path);
    yield* engine.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("rename-thread"),
      threadId,
      title: "Review history",
    });
    yield* store.change({
      workspaceId,
      commandId: CommandId.make("restoring"),
      change: { type: "restore-start", operationId: CommandId.make("restore") },
    });
    yield* store.change({
      workspaceId,
      commandId: CommandId.make("restored"),
      change: { type: "restore-complete" },
    });
    yield* engine.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("move-after-restore"),
      threadId,
      worktreePath: "/unowned",
    });
    expect(checkout).toBe("/unowned");
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(Sqlite.layerMemory, NodeServices.layer))),
);
