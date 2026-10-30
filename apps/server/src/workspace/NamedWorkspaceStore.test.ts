import { expect, it } from "@effect/vitest";
import { CommandId, NamedWorkspaceId, ThreadId, ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as NamedWorkspaceStore from "./NamedWorkspaceStore.ts";

it.effect("replays the latest committed state and does not apply a retried command twice", () =>
  Effect.gen(function* () {
    const first = yield* Layer.build(NamedWorkspaceStore.layer);
    const store = Context.get(first, NamedWorkspaceStore.NamedWorkspaceStore);
    const workspaceId = NamedWorkspaceId.make("workspace:account");
    const create = {
      commandId: CommandId.make("workspace:create"),
      workspaceId,
      change: { type: "create", name: "Account rollout" } as const,
    };
    const original = yield* store.change(create);
    expect(yield* store.change(create)).toEqual(original);
    yield* store.change({
      commandId: CommandId.make("workspace:rename"),
      workspaceId,
      change: { type: "rename", name: "Account launch" },
    });
    const pin = {
      commandId: CommandId.make("workspace:pin"),
      workspaceId,
      change: {
        type: "pin-thread",
        threadId: ThreadId.make("thread"),
        orderKey: "a",
        commandId: CommandId.make("workspace:pin"),
        workspaceId,
      } as const,
    };
    const pinned = yield* store.change(pin);
    expect(yield* store.change(pin)).toEqual(pinned);
    yield* store.change({
      commandId: CommandId.make("workspace:choice"),
      workspaceId,
      change: {
        type: "set-project-association",
        commandId: CommandId.make("workspace:choice"),
        workspaceId,
        projectId: ProjectId.make("api"),
        choice: "separate",
      },
    });
    const sql = yield* SqlClient.SqlClient;
    const count = yield* sql<{
      count: number;
    }>`SELECT COUNT(*) AS count FROM named_workspace_events`;
    expect(count[0]?.count).toBe(4);
    const restarted = yield* Layer.build(Layer.fresh(NamedWorkspaceStore.layer));
    const replayed = Context.get(restarted, NamedWorkspaceStore.NamedWorkspaceStore);
    expect(yield* replayed.get(workspaceId)).toMatchObject({
      name: "Account launch",
      version: 3,
      status: "active",
      associationChoices: [{ projectId: "api", choice: "separate" }],
      threadPlacements: [
        {
          threadId: "thread",
          pinnedAt: expect.any(String),
          pinOrderKey: "a",
          activeOrderKey: null,
        },
      ],
    });
    expect(yield* replayed.change(create)).toEqual(original);
    expect(yield* replayed.get(workspaceId)).toMatchObject({ name: "Account launch", version: 3 });
  }).pipe(Effect.scoped, Effect.provide(Sqlite.layerMemory)),
);
