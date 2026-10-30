import { expect, it } from "@effect/vitest";
import {
  CommandId,
  NamedWorkspaceError,
  NamedWorkspaceId,
  ProjectId,
  ThreadId,
  type NamedWorkspaceBlocker,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as Runtime from "./NamedWorkspaceRuntime.ts";
import * as Service from "./NamedWorkspaceService.ts";
import * as Store from "./NamedWorkspaceStore.ts";

const fixture = Effect.fn("workspaceTest.fixture")(function* () {
  const paths = new Set(["/worktrees/api", "/worktrees/web"]);
  const archived = new Set<string>();
  const blockers = new Map<string, readonly NamedWorkspaceBlocker[]>();
  const failRemoval = new Set<string>();
  const failRestore = new Set<string>();
  const projectId = ProjectId.make("project");
  const checkout = (path: string) => ({
    projectId,
    path,
    branch: path.split("/").at(-1)!,
    headCommit: "abc123",
  });
  const retained = new Set<string>();
  const runtime = Runtime.NamedWorkspaceRuntime.of({
    members: () =>
      Effect.sync(() => ({
        threadIds: [...paths].filter((path) => !archived.has(path)).map((id) => ThreadId.make(id)),
        retainedCheckoutPaths: [...retained],
        blockers: [],
      })),
    archiveThreads: (ids) =>
      Effect.sync(() => {
        for (const id of ids) archived.add(id);
      }),
    restoreThreads: (ids) =>
      Effect.sync(() => {
        for (const id of ids) archived.delete(id);
      }),
    matchingBranches: (_projectId, branches) =>
      Effect.succeed(
        [...new Set(branches)]
          .filter((branch) => branch === "api")
          .map((branch) => ({ branch, path: null, refName: branch })),
      ),
    checkoutBranch: (newProjectId, match) =>
      Effect.sync(() => ({
        ...checkout(`/worktrees/${newProjectId}-${match.branch}`),
        projectId: newProjectId,
        branch: match.branch,
      })),
    threadCheckout: (threadId) => Effect.succeed({ projectId, worktreePath: threadId }),
    adopt: (ownerId, path) =>
      Effect.succeed({
        ...checkout(path),
        projectId: ownerId,
        branch: path.includes("new-project") ? "api" : path.split("/").at(-1)!,
      }),
    inspect: (item) =>
      Effect.sync(() => ({
        checkout: item,
        exists: paths.has(item.path),
        threadIds: archived.has(item.path) ? [] : [ThreadId.make(item.path)],
        blockers: blockers.get(item.path) ?? [],
      })),
    archive: ({ checkout: item }) =>
      Effect.gen(function* () {
        archived.add(item.path);
        if (failRemoval.has(item.path))
          return yield* new NamedWorkspaceError({
            reason: "operation_failed",
            message: "Checkout removal failed.",
          });
        paths.delete(item.path);
      }),
    restore: ({ checkout: item }) =>
      Effect.gen(function* () {
        if (failRestore.has(item.path))
          return yield* new NamedWorkspaceError({
            reason: "blocked",
            message: "Saved branch changed.",
          });
        paths.add(item.path);
        archived.delete(item.path);
      }),
  });
  const context = yield* Layer.build(
    Service.layer.pipe(
      Layer.provideMerge(Store.layer),
      Layer.provide(Layer.succeed(Runtime.NamedWorkspaceRuntime, runtime)),
    ),
  );
  const service = Context.get(context, Service.NamedWorkspaceService);
  const store = Context.get(context, Store.NamedWorkspaceStore);
  const workspaceId = NamedWorkspaceId.make("workspace");
  yield* service.mutate({
    type: "create",
    workspaceId,
    commandId: CommandId.make("create"),
    name: "Account",
  });
  for (const path of paths)
    yield* service.mutate({
      type: "attach",
      workspaceId,
      commandId: CommandId.make(`attach:${path}`),
      projectId,
      path,
    });
  return {
    service,
    store,
    workspaceId,
    paths,
    archived,
    blockers,
    failRemoval,
    failRestore,
    retained,
  };
});

it.effect("blocks the entire archive before changing threads or directories", () =>
  Effect.gen(function* () {
    const { service, store, workspaceId, paths, archived, blockers } = yield* fixture();
    blockers.set("/worktrees/web", [
      { code: "local_changes", message: "Commit local changes first." },
    ]);
    const result = yield* service
      .mutate({ type: "archive", workspaceId, commandId: CommandId.make("archive") })
      .pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    expect(yield* store.get(workspaceId)).toMatchObject({
      status: "active",
      archivedThreadIds: [],
      operationId: null,
    });
    expect([...paths]).toEqual(["/worktrees/api", "/worktrees/web"]);
    expect(archived.size).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(Sqlite.layerMemory)),
);

it.effect("keeps partial cleanup retryable and restores only its saved workspace", () =>
  Effect.gen(function* () {
    const { service, store, workspaceId, paths, archived, failRemoval, failRestore } =
      yield* fixture();
    const other = NamedWorkspaceId.make("other");
    yield* service.mutate({
      type: "create",
      workspaceId: other,
      commandId: CommandId.make("other:create"),
      name: "Other",
    });
    const original = yield* store.get(workspaceId);
    failRemoval.add("/worktrees/web");
    yield* service
      .mutate({ type: "archive", workspaceId, commandId: CommandId.make("archive") })
      .pipe(Effect.result);
    expect([...paths]).toEqual(["/worktrees/web"]);
    expect(yield* store.get(workspaceId)).toMatchObject({
      status: "archiving",
      checkouts: original.checkouts,
      lastError: "Checkout removal failed.",
      archivedThreadIds: ["/worktrees/api", "/worktrees/web"],
    });
    expect(yield* store.assertAvailable("/worktrees/api").pipe(Effect.result)).toMatchObject({
      _tag: "Failure",
    });
    failRemoval.clear();
    yield* service.mutate({ type: "archive", workspaceId, commandId: CommandId.make("retry") });
    expect(paths.size).toBe(0);
    expect(yield* store.get(workspaceId)).toMatchObject({ status: "archived", lastError: null });
    failRestore.add("/worktrees/web");
    yield* service
      .mutate({ type: "restore", workspaceId, commandId: CommandId.make("restore") })
      .pipe(Effect.result);
    expect(yield* store.get(workspaceId)).toMatchObject({
      status: "restoring",
      checkouts: original.checkouts,
      lastError: "Saved branch changed.",
    });
    failRestore.clear();
    yield* service.recover;
    expect(yield* store.get(workspaceId)).toMatchObject({
      status: "active",
      archivedThreadIds: [],
      operationId: null,
    });
    expect(paths.size).toBe(2);
    expect(archived.size).toBe(0);
    expect(yield* store.get(other)).toMatchObject({ status: "active", checkouts: [], version: 0 });
    yield* service.mutate({ type: "archive", workspaceId, commandId: CommandId.make("archive") });
    expect(yield* store.get(workspaceId)).toMatchObject({ status: "active" });
    expect(paths.size).toBe(2);
  }).pipe(Effect.scoped, Effect.provide(Sqlite.layerMemory)),
);

it.effect("can undo an interrupted archive without forgetting checkout ownership", () =>
  Effect.gen(function* () {
    const { service, store, workspaceId, paths, failRemoval } = yield* fixture();
    failRemoval.add("/worktrees/web");
    yield* service
      .mutate({ type: "archive", workspaceId, commandId: CommandId.make("archive") })
      .pipe(Effect.result);
    yield* service.mutate({ type: "restore", workspaceId, commandId: CommandId.make("undo") });
    expect(paths.size).toBe(2);
    expect(yield* store.get(workspaceId)).toMatchObject({ status: "active", lastError: null });
    expect((yield* store.owner("/worktrees/api/"))?.id).toBe(workspaceId);
  }).pipe(Effect.scoped, Effect.provide(Sqlite.layerMemory)),
);

it.effect("arranges only threads whose checkout belongs to the destination workspace", () =>
  Effect.gen(function* () {
    const { service, store, workspaceId } = yield* fixture();
    const pin = {
      type: "pin-thread",
      workspaceId,
      commandId: CommandId.make("pin:api"),
      threadId: ThreadId.make("/worktrees/api"),
      orderKey: "a",
    } as const;
    yield* service.mutate(pin);
    expect((yield* store.get(workspaceId)).threadPlacements).toMatchObject([
      { threadId: pin.threadId, pinOrderKey: "a" },
    ]);
    expect(
      yield* service
        .mutate({
          ...pin,
          commandId: CommandId.make("pin:other"),
          threadId: ThreadId.make("/worktrees/unowned"),
        })
        .pipe(Effect.result),
    ).toMatchObject({ _tag: "Failure", failure: { reason: "conflict" } });
    yield* service.mutate({
      ...pin,
      type: "reorder-pinned-thread",
      orderKey: "b",
      commandId: CommandId.make("pin:reorder"),
    });
    yield* service.mutate({
      type: "archive",
      workspaceId,
      commandId: CommandId.make("archive:pin"),
    });
    yield* service.mutate({
      type: "restore",
      workspaceId,
      commandId: CommandId.make("restore:pin"),
    });
    expect((yield* store.get(workspaceId)).threadPlacements).toMatchObject([
      { threadId: pin.threadId, pinOrderKey: "b" },
    ]);
  }).pipe(Effect.scoped, Effect.provide(Sqlite.layerMemory)),
);

it.effect(
  "suggests exact existing branches and remembers choices for only the project-workspace pair",
  () =>
    Effect.gen(function* () {
      const { service, store, workspaceId } = yield* fixture();
      const projectId = ProjectId.make("new-project");
      expect(yield* service.suggestions(projectId)).toEqual([
        { workspaceId, branch: "api", path: null, choice: null },
      ]);
      yield* service.mutate({
        type: "set-project-association",
        commandId: CommandId.make("decline"),
        workspaceId,
        projectId,
        choice: "separate",
      });
      expect(yield* service.suggestions(projectId)).toMatchObject([{ choice: "separate" }]);
      const automatic = {
        type: "associate-project" as const,
        commandId: CommandId.make("automatic"),
        workspaceId,
        projectId,
        branch: "api",
        remember: true,
        automatic: true,
      };
      expect(yield* service.mutate(automatic).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "conflict" },
      });
      yield* service.mutate({
        ...automatic,
        commandId: CommandId.make("accept"),
        automatic: false,
      });
      expect((yield* store.get(workspaceId)).associationChoices).toEqual([
        { projectId, choice: "add" },
      ]);
      expect(yield* service.suggestions(projectId)).toEqual([]);
      yield* service.mutate({
        type: "detach",
        commandId: CommandId.make("detach-associated"),
        workspaceId,
        path: "/worktrees/new-project-api",
      });
      expect(yield* service.suggestions(projectId)).toMatchObject([{ choice: "add" }]);
      yield* Effect.all(
        [
          service.mutate(automatic),
          service.mutate({ ...automatic, commandId: CommandId.make("other-device") }),
        ],
        { concurrency: "unbounded" },
      );
      expect(
        (yield* store.get(workspaceId)).checkouts.filter((item) => item.projectId === projectId),
      ).toHaveLength(1);
      yield* service.mutate({
        type: "set-project-association",
        commandId: CommandId.make("forget"),
        workspaceId,
        projectId,
        choice: null,
      });
      expect((yield* store.get(workspaceId)).associationChoices).toEqual([]);
      expect(yield* service.suggestions(ProjectId.make("another-project"))).toMatchObject([
        { choice: null },
      ]);
      const reservedProject = ProjectId.make("reserved-project");
      const reservedWorkspace = NamedWorkspaceId.make("archived-owner");
      yield* store.change({
        commandId: CommandId.make("reserved:create"),
        workspaceId: reservedWorkspace,
        change: { type: "create", name: "Archived owner" },
      });
      const reservedCheckout = {
        projectId: reservedProject,
        path: "/worktrees/missing-archived",
        branch: "api",
        headCommit: "saved",
      };
      yield* store.change({
        commandId: CommandId.make("reserved:attach"),
        workspaceId: reservedWorkspace,
        change: { type: "attach", checkout: reservedCheckout },
      });
      yield* store.change({
        commandId: CommandId.make("reserved:start"),
        workspaceId: reservedWorkspace,
        change: {
          type: "archive-start",
          operationId: CommandId.make("reserved:archive"),
          checkouts: [reservedCheckout],
          threadIds: [],
        },
      });
      yield* store.change({
        commandId: CommandId.make("reserved:complete"),
        workspaceId: reservedWorkspace,
        change: { type: "archive-complete" },
      });
      expect(yield* service.suggestions(reservedProject)).toEqual([]);
      expect(
        yield* service
          .mutate({
            ...automatic,
            commandId: CommandId.make("reserved:attempt"),
            projectId: reservedProject,
            automatic: false,
          })
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "conflict" } });
    }).pipe(Effect.scoped, Effect.provide(Sqlite.layerMemory)),
);

it.effect(
  "archives only member threads and keeps shared checkouts available outside the Space",
  () =>
    Effect.gen(function* () {
      const { service, store, workspaceId, paths, retained } = yield* fixture();
      retained.add("/worktrees/web");
      yield* service.mutate({
        type: "archive",
        workspaceId,
        commandId: CommandId.make("shared:archive"),
      });
      expect([...paths]).toEqual(["/worktrees/web"]);
      expect((yield* store.get(workspaceId)).retainedCheckoutPaths).toEqual(["/worktrees/web"]);
      yield* store.assertAvailable("/worktrees/web");
      expect(yield* store.assertAvailable("/worktrees/api").pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
      });
      retained.clear();
      yield* service.mutate({
        type: "archive",
        workspaceId,
        commandId: CommandId.make("shared:cleanup"),
      });
      expect(paths.size).toBe(0);
      expect((yield* store.get(workspaceId)).retainedCheckoutPaths).toEqual([]);
      yield* service.mutate({
        type: "restore",
        workspaceId,
        commandId: CommandId.make("shared:restore"),
      });
      expect([...paths].sort()).toEqual(["/worktrees/api", "/worktrees/web"]);
    }).pipe(Effect.scoped, Effect.provide(Sqlite.layerMemory)),
);
