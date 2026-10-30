import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, NamedWorkspaceId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as Sessions from "../orchestration-v2/ProviderSessionManager.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Terminals from "../terminal/Manager.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Runtime from "./NamedWorkspaceRuntime.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";

const fixture = Effect.fn("workspaceRuntimeTest.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const git = yield* Git.GitVcsDriver;
  const root = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "named-workspace-" }),
  );
  const repo = `${root}/repo`;
  const worktree = `${root}/checkout`;
  yield* fs.makeDirectory(repo);
  const command = Effect.fn("workspaceRuntimeTest.git")(function* (
    cwd: string,
    args: readonly string[],
  ) {
    const result = yield* git.execute({ operation: "workspace-test", cwd, args });
    expect(result.exitCode).toBe(0);
    return result.stdout.trim();
  });
  yield* command(repo, ["init", "-b", "main"]);
  yield* command(repo, ["config", "user.email", "workspace@example.test"]);
  yield* command(repo, ["config", "user.name", "Workspace test"]);
  yield* fs.writeFileString(`${repo}/tracked.txt`, "original\n");
  yield* fs.writeFileString(`${repo}/.gitignore`, ".env\nnode_modules/\n");
  yield* command(repo, ["add", "."]);
  yield* command(repo, ["commit", "-m", "initial"]);
  yield* command(repo, ["worktree", "add", "-b", "feature", worktree]);
  const projectId = ProjectId.make("project");
  let projectRoots = [repo];
  let archivedAt: string | null = null;
  let queued = false;
  let spaceId: import("@t3tools/contracts").NamedWorkspaceId | null | undefined;
  const threadId = ThreadId.make("thread");
  const shell = () => ({
    id: threadId,
    projectId,
    worktreePath: worktree,
    ...(spaceId === undefined ? {} : { spaceId }),
    archivedAt,
    deletedAt: null,
    activeRunId: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    status: "idle",
    latestUserMessageAt: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestRunId: null,
  });
  const context = yield* Layer.build(
    Runtime.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(GitWorkflow.GitWorkflowService)({
            createWorktree: (input) =>
              git.createWorktree({ ...input, path: input.path ?? `${root}/created` }),
          }),
          Layer.mock(Projects.ProjectStoreV2)({
            get: () =>
              Effect.succeedSome({
                projectId,
                title: "Project",
                workspaceRoot: repo,
                defaultModelSelection: null,
                defaultThreadEnvMode: null,
                autoPull: false,
                faviconPath: null,
                projectIcon: null,
                scripts: [],
                createdAt: "2026-10-29T12:00:00.000Z",
                updatedAt: "2026-10-29T12:00:00.000Z",
                deletedAt: null,
              }),
            list: () =>
              Effect.succeed(
                projectRoots.map((workspaceRoot) => ({
                  projectId,
                  title: "Project",
                  workspaceRoot,
                  defaultModelSelection: null,
                  defaultThreadEnvMode: null,
                  autoPull: false,
                  faviconPath: null,
                  projectIcon: null,
                  scripts: [],
                  createdAt: "2026-10-29T12:00:00.000Z",
                  updatedAt: "2026-10-29T12:00:00.000Z",
                  deletedAt: null,
                })),
              ),
          }),
          Layer.mock(Threads.ThreadManagementService)({
            readShellSnapshot: () =>
              Effect.succeed(
                Effect.sync(() => ({ threads: archivedAt === null ? [shell()] : [] }) as never),
              ),
            getThreadShell: () => Effect.sync(() => shell() as never),
            getThreadRecords: () =>
              Effect.sync(
                () =>
                  ({ runs: queued ? [{ status: "queued" }] : [], providerSessions: [] }) as never,
              ),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            dispatch: (command) =>
              Effect.sync(() => {
                if (command.type === "thread.archive") archivedAt = "2026-10-29T12:00:00.000Z";
                if (command.type === "thread.unarchive") archivedAt = null;
                return { sequence: 1, storedEvents: [] };
              }),
          }),
          Layer.mock(Sessions.ProviderSessionManagerV2)({}),
          Layer.mock(Terminals.TerminalManager)({
            subscribeMetadata: () => Effect.succeed(() => {}),
            closeIdle: () => Effect.void,
          }),
        ),
      ),
    ),
  );
  return {
    fs,
    git,
    runtime: Context.get(context, Runtime.NamedWorkspaceRuntime),
    projectId,
    repo,
    worktree,
    command,
    threadId,
    archived: () => archivedAt !== null,
    setSpace: (value: import("@t3tools/contracts").NamedWorkspaceId | null) => {
      spaceId = value;
    },
    setQueued: (value: boolean) => {
      queued = value;
    },
    protectCheckout: () => {
      projectRoots = [repo, worktree];
    },
  };
});

const layerTest = Git.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "named-workspace-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.live(
  "protects local files and project roots, removes clean checkouts, and restores the saved branch",
  () =>
    Effect.gen(function* () {
      const { fs, runtime, projectId, repo, worktree, command, threadId, archived, setQueued } =
        yield* fixture();
      expect(yield* runtime.adopt(projectId, repo).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
      });
      const checkout = yield* runtime.adopt(projectId, worktree);
      yield* fs.writeFileString(`${worktree}/.env`, "private local fixture\n");
      expect(
        (yield* runtime.inspect(checkout, true)).blockers.map((blocker) => blocker.code),
      ).toContain("ignored_files");
      expect(
        yield* runtime
          .archive({ checkout, threadIds: [threadId], commandId: CommandId.make("blocked") })
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure" });
      expect(yield* fs.exists(worktree)).toBe(true);
      yield* fs.remove(`${worktree}/.env`);
      yield* fs.writeFileString(`${worktree}/local.txt`, "untracked\n");
      expect(
        (yield* runtime.inspect(checkout, true)).blockers.map((blocker) => blocker.code),
      ).toContain("local_changes");
      yield* fs.remove(`${worktree}/local.txt`);
      setQueued(true);
      expect(
        (yield* runtime.inspect(checkout, true)).blockers.map((blocker) => blocker.code),
      ).toContain("active_work");
      setQueued(false);
      yield* fs.makeDirectory(`${worktree}/node_modules`);
      yield* fs.writeFileString(`${worktree}/node_modules/cache`, "recreatable\n");
      yield* runtime.archive({
        checkout,
        threadIds: [threadId],
        commandId: CommandId.make("archive"),
      });
      expect(yield* fs.exists(worktree)).toBe(false);
      expect(archived()).toBe(true);
      expect(yield* command(repo, ["rev-parse", "refs/heads/feature"])).toBe(checkout.headCommit);
      yield* runtime.restore({
        checkout,
        threadIds: [threadId],
        commandId: CommandId.make("restore"),
      });
      expect(yield* fs.readFileString(`${worktree}/tracked.txt`)).toBe("original\n");
      expect(archived()).toBe(false);
      yield* runtime.archive({
        checkout,
        threadIds: [threadId],
        commandId: CommandId.make("archive-again"),
      });
      yield* command(repo, ["branch", "-D", "feature"]);
      expect(
        yield* runtime
          .restore({ checkout, threadIds: [threadId], commandId: CommandId.make("missing-branch") })
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure" });
      expect(yield* fs.exists(worktree)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.live("refuses a checkout that became a project root or moved beyond the saved revision", () =>
  Effect.gen(function* () {
    const { fs, runtime, projectId, worktree, command, protectCheckout } = yield* fixture();
    const checkout = yield* runtime.adopt(projectId, worktree);
    yield* fs.writeFileString(`${worktree}/tracked.txt`, "committed later\n");
    yield* command(worktree, ["add", "."]);
    yield* command(worktree, ["commit", "-m", "later"]);
    expect(
      (yield* runtime.inspect(checkout, true)).blockers.map((blocker) => blocker.code),
    ).toContain("changed_head");
    expect(
      yield* runtime
        .archive({ checkout, threadIds: [], commandId: CommandId.make("changed") })
        .pipe(Effect.result),
    ).toMatchObject({ _tag: "Failure" });
    protectCheckout();
    expect(yield* runtime.adopt(projectId, worktree).pipe(Effect.result)).toMatchObject({
      _tag: "Failure",
    });
    expect(yield* fs.exists(worktree)).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.live(
  "matches full branch names, prefers local branches, protects project roots, and reuses or creates worktrees",
  () =>
    Effect.gen(function* () {
      const { runtime, projectId, repo, worktree, command } = yield* fixture();
      yield* command(worktree, ["branch", "-m", "feature/legacy"]);
      yield* command(repo, ["branch", "feature/account"]);
      yield* command(repo, ["remote", "add", "origin", repo]);
      yield* command(repo, ["update-ref", "refs/remotes/origin/feature/account", "HEAD"]);
      const matches = yield* runtime.matchingBranches(projectId, [
        "main",
        "account",
        "Feature/account",
        "feature/legacy",
        "feature/account",
        "feature/account",
      ]);
      expect(matches).toEqual([
        { branch: "feature/legacy", path: worktree, refName: "feature/legacy" },
        { branch: "feature/account", path: null, refName: "feature/account" },
      ]);
      expect((yield* runtime.checkoutBranch(projectId, matches[0]!)).path).toBe(worktree);
      const created = yield* runtime.checkoutBranch(projectId, matches[1]!);
      expect(created.branch).toBe("feature/account");
      expect(created.path).not.toBe(repo);
      yield* command(repo, ["update-ref", "refs/remotes/origin/remote-only", "HEAD"]);
      expect(yield* runtime.matchingBranches(projectId, ["remote-only"])).toEqual([
        {
          branch: "remote-only",
          path: null,
          refName: "origin/remote-only",
          newRefName: "remote-only",
        },
      ]);
      yield* command(repo, ["remote", "add", "other", repo]);
      yield* command(repo, ["update-ref", "refs/remotes/other/remote-only", "HEAD"]);
      expect(yield* runtime.matchingBranches(projectId, ["remote-only"])).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.live("keeps checkout ownership separate when one thread moves to another Space", () =>
  Effect.gen(function* () {
    const { runtime, projectId, worktree, setSpace } = yield* fixture();
    const checkout = yield* runtime.adopt(projectId, worktree);
    const owner = {
      id: NamedWorkspaceId.make("owner"),
      name: "Owner",
      version: 0,
      status: "active" as const,
      checkouts: [checkout],
      threadPlacements: [],
      associationChoices: [],
      retainedCheckoutPaths: [],
      createdAt: "2026-10-30T00:00:00Z",
      updatedAt: "2026-10-30T00:00:00Z",
      archivedAt: null,
      lastError: null,
    };
    const destination = { ...owner, id: NamedWorkspaceId.make("destination"), checkouts: [] };
    expect((yield* runtime.members(owner, [owner, destination])).threadIds).toEqual(["thread"]);
    setSpace(destination.id);
    expect(yield* runtime.members(owner, [owner, destination])).toMatchObject({
      threadIds: [],
      retainedCheckoutPaths: [worktree],
    });
    expect((yield* runtime.members(destination, [owner, destination])).threadIds).toEqual([
      "thread",
    ]);
    setSpace(null);
    expect((yield* runtime.members(destination, [owner, destination])).threadIds).toEqual([]);
    expect((yield* runtime.adopt(projectId, worktree)).path).toBe(worktree);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);
