import {
  CommandId,
  NamedWorkspace,
  NamedWorkspaceError,
  NamedWorkspaceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";

import {
  planWorkspaceChange,
  type WorkspaceChange,
  type WorkspaceRecord,
} from "./NamedWorkspaceModel.ts";

const StoredWorkspace = Schema.Struct({
  ...NamedWorkspace.fields,
  archivedThreadIds: Schema.Array(ThreadId),
  operationId: Schema.NullOr(CommandId),
});
const StoredWorkspaceJson = Schema.fromJsonString(StoredWorkspace);
const decode = Schema.decodeUnknownEffect(StoredWorkspaceJson);
const encode = Schema.encodeSync(StoredWorkspaceJson);

export class NamedWorkspaceStore extends Context.Service<
  NamedWorkspaceStore,
  {
    readonly list: Effect.Effect<readonly WorkspaceRecord[]>;
    readonly get: (id: NamedWorkspaceId) => Effect.Effect<WorkspaceRecord, NamedWorkspaceError>;
    readonly owner: (path: string) => Effect.Effect<WorkspaceRecord | undefined>;
    readonly assertAvailable: (path: string) => Effect.Effect<void, NamedWorkspaceError>;
    readonly change: (input: {
      readonly commandId: CommandId;
      readonly workspaceId: NamedWorkspaceId;
      readonly change: WorkspaceChange;
    }) => Effect.Effect<WorkspaceRecord, NamedWorkspaceError>;
    readonly stream: Stream.Stream<readonly NamedWorkspace[]>;
  }
>()("t3/workspace/NamedWorkspaceStore") {}

export function workspaceForClient({
  archivedThreadIds: _archivedThreadIds,
  operationId: _operationId,
  ...workspace
}: WorkspaceRecord): NamedWorkspace {
  return workspace;
}

const isWorkspaceError = Schema.is(NamedWorkspaceError);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const lock = yield* Semaphore.make(1);
  const rows = yield* sql<{ state_json: string }>`
    SELECT state_json FROM named_workspace_events
    WHERE sequence IN (
      SELECT MAX(sequence) FROM named_workspace_events GROUP BY workspace_id
    )
    ORDER BY sequence ASC
  `.pipe(
    Effect.mapError(
      (cause) =>
        new NamedWorkspaceError({
          reason: "storage",
          message: "The workspace catalog could not be read.",
          cause,
        }),
    ),
  );
  const initial = yield* Effect.forEach(rows, (row) => decode(row.state_json)).pipe(
    Effect.mapError(
      (cause) =>
        new NamedWorkspaceError({
          reason: "storage",
          message: "The saved workspace catalog is invalid.",
          cause,
        }),
    ),
  );
  const current = yield* SubscriptionRef.make<readonly WorkspaceRecord[]>(initial);
  const get = Effect.fn("NamedWorkspaceStore.get")(function* (id: NamedWorkspaceId) {
    const workspace = (yield* SubscriptionRef.get(current)).find((entry) => entry.id === id);
    if (!workspace)
      return yield* new NamedWorkspaceError({
        reason: "not_found",
        workspaceId: id,
        message: "This workspace is unavailable.",
      });
    return workspace;
  });
  const owner = Effect.fn("NamedWorkspaceStore.owner")(function* (path: string) {
    const key = normalizeProjectPathForComparison(path);
    return (yield* SubscriptionRef.get(current)).find((workspace) =>
      workspace.checkouts.some(
        (checkout) => normalizeProjectPathForComparison(checkout.path) === key,
      ),
    );
  });
  const assertAvailable = Effect.fn("NamedWorkspaceStore.assertAvailable")(function* (
    path: string,
  ) {
    const workspace = yield* owner(path);
    if (
      workspace &&
      workspace.status !== "active" &&
      !workspace.retainedCheckoutPaths.some(
        (item) =>
          normalizeProjectPathForComparison(item) === normalizeProjectPathForComparison(path),
      )
    )
      return yield* new NamedWorkspaceError({
        reason: "blocked",
        workspaceId: workspace.id,
        message: "Restore this workspace before starting work in its checkout.",
      });
  });
  const change = Effect.fn("NamedWorkspaceStore.change")(function* (input: {
    readonly commandId: CommandId;
    readonly workspaceId: NamedWorkspaceId;
    readonly change: WorkspaceChange;
  }) {
    return yield* lock
      .withPermit(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const repeated = yield* sql<{
              workspace_id: string;
              event_type: string;
              state_json: string;
            }>`
        SELECT workspace_id, event_type, state_json FROM named_workspace_events
        WHERE command_id = ${input.commandId}
      `;
            if (repeated[0]) {
              if (
                repeated[0].workspace_id !== input.workspaceId ||
                repeated[0].event_type !== input.change.type
              ) {
                return yield* new NamedWorkspaceError({
                  reason: "conflict",
                  workspaceId: input.workspaceId,
                  message: "This command already belongs to another workspace operation.",
                });
              }
              return yield* decode(repeated[0].state_json);
            }
            const workspaces = yield* SubscriptionRef.get(current);
            const result = planWorkspaceChange({
              workspaces,
              workspaceId: input.workspaceId,
              change: input.change,
              now: DateTime.formatIso(yield* DateTime.now),
            });
            if (Result.isFailure(result)) return yield* result.failure;
            const workspace = result.success;
            yield* sql`
        INSERT INTO named_workspace_events (command_id, workspace_id, event_type, state_json)
        VALUES (${input.commandId}, ${input.workspaceId}, ${input.change.type}, ${encode(workspace)})
      `;
            // Pending lifecycle states are committed before checkout or provider I/O begins.
            yield* SubscriptionRef.set(current, [
              ...workspaces.filter((entry) => entry.id !== workspace.id),
              workspace,
            ]);
            return workspace;
          }),
        ),
      )
      .pipe(
        Effect.mapError((cause) =>
          isWorkspaceError(cause)
            ? cause
            : new NamedWorkspaceError({
                reason: "storage",
                workspaceId: input.workspaceId,
                message: "The workspace change could not be saved.",
                cause,
              }),
        ),
      );
  });
  return NamedWorkspaceStore.of({
    list: SubscriptionRef.get(current),
    get,
    owner,
    assertAvailable,
    change,
    stream: SubscriptionRef.changes(current).pipe(
      Stream.map((workspaces) => workspaces.map(workspaceForClient)),
    ),
  });
});

export const layer = Layer.effect(NamedWorkspaceStore, make);
