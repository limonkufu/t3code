import { resolveThreadSpaceId } from "@t3tools/shared/threadSpace";
import {
  CommandId,
  NamedWorkspaceError,
  type NamedWorkspace,
  type NamedWorkspaceId,
  type NamedWorkspaceBlocker,
  type NamedWorkspaceCheckout,
  type ProjectId,
  type TerminalSummary,
  type ThreadId,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { threadHasQueuedTurnStart } from "../orchestration-v2/ThreadSettlementService.ts";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderSessions from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Terminals from "../terminal/Manager.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";

interface BranchMatch {
  readonly branch: string;
  readonly path: string | null;
  readonly refName: string;
  readonly newRefName?: string;
}

export interface WorkspaceCheckoutInspection {
  readonly checkout: NamedWorkspaceCheckout;
  readonly exists: boolean;
  readonly threadIds: readonly ThreadId[];
  readonly blockers: readonly NamedWorkspaceBlocker[];
}

export class NamedWorkspaceRuntime extends Context.Service<
  NamedWorkspaceRuntime,
  {
    readonly members: (
      space: NamedWorkspace,
      catalog: readonly NamedWorkspace[],
    ) => Effect.Effect<
      {
        readonly threadIds: readonly ThreadId[];
        readonly retainedCheckoutPaths: readonly string[];
        readonly blockers: readonly NamedWorkspaceBlocker[];
      },
      NamedWorkspaceError
    >;
    readonly archiveThreads: (
      threadIds: readonly ThreadId[],
      commandId: CommandId,
    ) => Effect.Effect<void, NamedWorkspaceError>;
    readonly restoreThreads: (
      threadIds: readonly ThreadId[],
      commandId: CommandId,
    ) => Effect.Effect<void, NamedWorkspaceError>;
    readonly matchingBranches: (
      projectId: ProjectId,
      branches: readonly string[],
    ) => Effect.Effect<readonly BranchMatch[], NamedWorkspaceError>;
    readonly checkoutBranch: (
      projectId: ProjectId,
      match: BranchMatch,
    ) => Effect.Effect<NamedWorkspaceCheckout, NamedWorkspaceError>;
    readonly threadCheckout: (threadId: ThreadId) => Effect.Effect<
      {
        readonly projectId: ProjectId;
        readonly worktreePath: string | null;
        readonly spaceId?: NamedWorkspaceId | null;
      },
      NamedWorkspaceError
    >;
    readonly adopt: (
      projectId: ProjectId,
      path: string,
    ) => Effect.Effect<NamedWorkspaceCheckout, NamedWorkspaceError>;
    readonly inspect: (
      checkout: NamedWorkspaceCheckout,
      verifyRevision: boolean,
    ) => Effect.Effect<WorkspaceCheckoutInspection, NamedWorkspaceError>;
    readonly archive: (input: {
      readonly checkout: NamedWorkspaceCheckout;
      readonly threadIds: readonly ThreadId[];
      readonly commandId: CommandId;
    }) => Effect.Effect<void, NamedWorkspaceError>;
    readonly restore: (input: {
      readonly checkout: NamedWorkspaceCheckout;
      readonly threadIds: readonly ThreadId[];
      readonly commandId: CommandId;
    }) => Effect.Effect<void, NamedWorkspaceError>;
  }
>()("t3/workspace/NamedWorkspaceRuntime") {}

const isWorkspaceError = Schema.is(NamedWorkspaceError);

const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  // Recovery dispatches under leases already held by the workspace service.
  const lifecycle = yield* Orchestrator.OrchestratorV2;
  const sessions = yield* ProviderSessions.ProviderSessionManagerV2;
  const terminals = yield* Terminals.TerminalManager;
  const git = yield* Git.GitVcsDriver;
  const workflow = yield* GitWorkflow.GitWorkflowService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const liveTerminals = new Map<string, TerminalSummary>();
  const stop = yield* terminals.subscribeMetadata((event) =>
    Effect.sync(() => {
      if (event.type === "snapshot") {
        liveTerminals.clear();
        for (const terminal of event.terminals)
          liveTerminals.set(`${terminal.threadId}:${terminal.terminalId}`, terminal);
      } else if (event.type === "upsert") {
        liveTerminals.set(
          `${event.terminal.threadId}:${event.terminal.terminalId}`,
          event.terminal,
        );
      } else {
        liveTerminals.delete(`${event.threadId}:${event.terminalId}`);
      }
    }),
  );
  yield* Effect.addFinalizer(() => Effect.sync(stop));
  const key = (value: string) => normalizeProjectPathForComparison(path.resolve(value));
  const inside = (root: string, value: string) =>
    key(value) === key(root) || key(value).startsWith(`${key(root)}${path.sep}`);
  const operationError = (cause: unknown) =>
    isWorkspaceError(cause)
      ? cause
      : new NamedWorkspaceError({
          reason: "operation_failed",
          message: "The checkout operation failed. Review the checkout and retry.",
          cause,
        });
  const threadCheckout = Effect.fn("NamedWorkspaceRuntime.threadCheckout")(function* (
    threadId: ThreadId,
  ) {
    const thread = yield* threads.getThreadShell(threadId);
    if (!thread || thread.deletedAt !== null)
      return yield* new NamedWorkspaceError({
        reason: "not_found",
        message: "This thread is unavailable.",
      });
    return {
      projectId: thread.projectId,
      worktreePath: thread.worktreePath,
      ...(thread.spaceId === undefined ? {} : { spaceId: thread.spaceId }),
    };
  }, Effect.mapError(operationError));
  const project = Effect.fn("NamedWorkspaceRuntime.project")(function* (projectId: ProjectId) {
    const found = yield* projects.get(projectId);
    if (Option.isNone(found))
      return yield* new NamedWorkspaceError({
        reason: "invalid_checkout",
        message: "The checkout's project is unavailable.",
      });
    return found.value;
  });
  const output = Effect.fn("NamedWorkspaceRuntime.gitOutput")(function* (
    cwd: string,
    args: readonly string[],
  ) {
    const result = yield* git.execute({
      operation: "NamedWorkspaceRuntime.inspect",
      cwd,
      args,
      maxOutputBytes: 256 * 1024,
    });
    if (result.exitCode !== 0 || result.stdoutTruncated || result.stderrTruncated)
      return yield* new NamedWorkspaceError({
        reason: "invalid_checkout",
        message: "The checkout could not be inspected safely.",
      });
    return result.stdout;
  });
  const adopt = Effect.fn("NamedWorkspaceRuntime.adopt")(function* (
    projectId: ProjectId,
    inputPath: string,
  ) {
    const owner = yield* project(projectId);
    const cwd = yield* fs.realPath(path.resolve(inputPath));
    const allProjects = yield* projects.list();
    for (const candidate of allProjects) {
      const root = yield* fs
        .realPath(candidate.workspaceRoot)
        .pipe(Effect.orElseSucceed(() => path.resolve(candidate.workspaceRoot)));
      if (inside(cwd, root))
        return yield* new NamedWorkspaceError({
          reason: "invalid_checkout",
          message: "A project checkout cannot be owned or removed by a workspace.",
        });
    }
    if ((yield* fs.stat(path.join(cwd, ".git"))).type !== "File") {
      return yield* new NamedWorkspaceError({
        reason: "invalid_checkout",
        message: "Choose a linked Git worktree, rather than a project's main checkout.",
      });
    }
    const common = (yield* output(cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ])).trim();
    const ownerCommon = (yield* output(owner.workspaceRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ])).trim();
    if (key(common) !== key(ownerCommon))
      return yield* new NamedWorkspaceError({
        reason: "invalid_checkout",
        message: "This checkout belongs to a different repository.",
      });
    const registered = yield* git.listWorktreePaths(owner.workspaceRoot);
    if (!registered.some((entry) => key(entry) === key(cwd)))
      return yield* new NamedWorkspaceError({
        reason: "invalid_checkout",
        message: "This directory is not a registered worktree of the project.",
      });
    const branch = (yield* output(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
    const headCommit = (yield* output(cwd, ["rev-parse", "--verify", "HEAD"])).trim();
    return { projectId, path: cwd, branch, headCommit };
  }, Effect.mapError(operationError));

  const matchingBranches = Effect.fn("NamedWorkspaceRuntime.matchingBranches")(function* (
    projectId: ProjectId,
    branches: readonly string[],
  ) {
    const owner = yield* project(projectId);
    const matches: BranchMatch[] = [];
    const names = (yield* output(owner.workspaceRoot, ["remote"]))
      .trim()
      .split("\n")
      .filter(Boolean)
      .toSorted((a, b) => b.length - a.length);
    for (const branch of new Set(branches)) {
      // Picker ref lists coalesce refreshes; ownership decisions need the current refs and paths.
      const rows = (yield* output(owner.workspaceRoot, [
        "for-each-ref",
        "--format=%(refname)%09%(worktreepath)",
        `refs/heads/${branch}`,
        `refs/remotes/*/${branch}`,
      ]))
        .trimEnd()
        .split("\n");
      const refs = rows.flatMap((row) => {
        const [name, checkoutPath] = row.split("\t");
        if (name === `refs/heads/${branch}`)
          return [{ name: branch, isRemote: false, worktreePath: checkoutPath || null }];
        const remote = names.find((remoteName) => name === `refs/remotes/${remoteName}/${branch}`);
        return remote ? [{ name: `${remote}/${branch}`, isRemote: true, worktreePath: null }] : [];
      });
      const local = refs.find((ref) => !ref.isRemote);
      const remotes = refs.filter((ref) => ref.isRemote);
      const ref = local ?? (remotes.length === 1 ? remotes[0] : undefined);
      if (!ref) continue;
      if (ref.worktreePath !== null) {
        const valid = yield* adopt(projectId, ref.worktreePath).pipe(Effect.result);
        if (Result.isFailure(valid) || valid.success.branch !== branch) continue;
      }
      matches.push({
        branch,
        path: ref.worktreePath,
        refName: ref.name,
        ...(ref.isRemote ? { newRefName: branch } : {}),
      });
    }
    return matches;
  }, Effect.mapError(operationError));

  const checkoutBranch = Effect.fn("NamedWorkspaceRuntime.checkoutBranch")(function* (
    projectId: ProjectId,
    match: BranchMatch,
  ) {
    const owner = yield* project(projectId);
    const checkoutPath =
      match.path ??
      (yield* workflow.createWorktree({
        cwd: owner.workspaceRoot,
        refName: match.refName,
        newRefName: match.newRefName,
        path: null,
      })).worktree.path;
    const checkout = yield* adopt(projectId, checkoutPath);
    if (checkout.branch !== match.branch)
      return yield* new NamedWorkspaceError({
        reason: "conflict",
        message: "The matching branch changed. Review the project and try again.",
      });
    return checkout;
  }, Effect.mapError(operationError));

  const threadBlockers = Effect.fn("NamedWorkspaceRuntime.threadBlockers")(function* (
    ids: readonly ThreadId[],
  ) {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    for (const id of ids) {
      const shell = yield* threads.getThreadShell(id);
      if (!shell || shell.deletedAt !== null || shell.archivedAt !== null) continue;
      if (
        [...liveTerminals.values()].some(
          (terminal) =>
            terminal.threadId === id &&
            (terminal.status === "starting" ||
              (terminal.status === "running" && terminal.hasRunningSubprocess)),
        )
      )
        return [{ code: "terminal" as const, message: "A thread has a terminal running work." }];
      const records = yield* threads.getThreadRecords(id, ["runs"]);
      if (
        shell.activeRunId !== null ||
        shell.pendingRuntimeRequest !== null ||
        (shell.pendingBackgroundTasks?.length ?? 0) > 0 ||
        threadHasQueuedTurnStart(shell, now) ||
        records.runs.some((run) =>
          ["queued", "preparing", "starting", "running", "waiting"].includes(run.status),
        )
      )
        return [
          {
            code: "active_work" as const,
            message: "A thread is working, queued, or waiting for a response.",
          },
        ];
    }
    return [];
  });
  const members = Effect.fn("NamedWorkspaceRuntime.members")(function* (
    space: NamedWorkspace,
    catalog: readonly NamedWorkspace[],
  ) {
    const activeSnapshot = yield* threads.readShellSnapshot({ location: "active" });
    const archivedSnapshot = yield* threads.readShellSnapshot({ location: "archive" });
    const active = (yield* activeSnapshot).threads;
    const archived = (yield* archivedSnapshot).threads;
    const threadIds = active
      .filter(
        (thread) => thread.deletedAt === null && resolveThreadSpaceId(thread, catalog) === space.id,
      )
      .map((thread) => thread.id);
    const retainedCheckoutPaths = space.checkouts
      .filter((checkout) =>
        [...active, ...archived].some(
          (thread) =>
            thread.deletedAt === null &&
            thread.worktreePath !== null &&
            key(thread.worktreePath) === key(checkout.path) &&
            resolveThreadSpaceId(thread, catalog) !== space.id,
        ),
      )
      .map((checkout) => checkout.path);
    return { threadIds, retainedCheckoutPaths, blockers: yield* threadBlockers(threadIds) };
  }, Effect.mapError(operationError));
  const archiveThreads = Effect.fn("NamedWorkspaceRuntime.archiveThreads")(function* (
    threadIds: readonly ThreadId[],
    commandId: CommandId,
  ) {
    const blockers = yield* threadBlockers(threadIds);
    if (blockers[0])
      return yield* new NamedWorkspaceError({ reason: "blocked", message: blockers[0].message });
    for (const threadId of threadIds) {
      const shell = yield* threads.getThreadShell(threadId);
      if (!shell || shell.deletedAt !== null || shell.archivedAt !== null) continue;
      const records = yield* threads.getThreadRecords(threadId, ["providerSessions"]);
      for (const session of records.providerSessions)
        yield* sessions.detach({ providerSessionId: session.id, threadId });
      yield* terminals.closeIdle({ threadId });
      yield* lifecycle.dispatch({
        type: "thread.archive",
        commandId: CommandId.make(`${commandId}:${threadId}:archive`),
        threadId,
      });
    }
  }, Effect.mapError(operationError));
  const restoreThreads = Effect.fn("NamedWorkspaceRuntime.restoreThreads")(function* (
    threadIds: readonly ThreadId[],
    commandId: CommandId,
  ) {
    for (const threadId of threadIds) {
      const shell = yield* threads.getThreadShell(threadId);
      if (shell && shell.deletedAt === null && shell.archivedAt !== null)
        yield* lifecycle.dispatch({
          type: "thread.unarchive",
          commandId: CommandId.make(`${commandId}:${threadId}:restore`),
          threadId,
        });
    }
  }, Effect.mapError(operationError));

  const inspect = Effect.fn("NamedWorkspaceRuntime.inspect")(function* (
    checkout: NamedWorkspaceCheckout,
    verifyRevision: boolean,
  ) {
    const snapshot = yield* threads.readShellSnapshot({
      worktreePath: checkout.path,
      location: "active",
    });
    const activeThreads = (yield* snapshot).threads;
    const blockers: NamedWorkspaceBlocker[] = [];
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const runs = yield* Effect.forEach(activeThreads, (thread) =>
      threads.getThreadRecords(thread.id, ["runs"]),
    );
    if (
      activeThreads.some(
        (thread) =>
          thread.activeRunId !== null ||
          thread.pendingRuntimeRequest !== null ||
          (thread.pendingBackgroundTasks?.length ?? 0) > 0 ||
          threadHasQueuedTurnStart(thread, now),
      ) ||
      runs.some((records) =>
        records.runs.some((run) =>
          ["queued", "preparing", "starting", "running", "waiting"].includes(run.status),
        ),
      )
    ) {
      blockers.push({
        code: "active_work",
        message: "A thread is working, queued, or waiting for a response.",
      });
    }
    const threadIds = activeThreads.map((thread) => thread.id);
    for (const terminal of liveTerminals.values()) {
      if (terminal.status !== "starting" && terminal.status !== "running") continue;
      if (
        !inside(checkout.path, terminal.cwd) &&
        (terminal.worktreePath === null || key(terminal.worktreePath) !== key(checkout.path))
      )
        continue;
      if (
        terminal.status === "starting" ||
        terminal.hasRunningSubprocess ||
        !threadIds.includes(terminal.threadId as ThreadId)
      ) {
        blockers.push({
          code: "terminal",
          message: "A terminal in this checkout is running work or belongs to another thread.",
        });
        break;
      }
    }
    const exists = yield* fs.exists(checkout.path);
    if (!exists) return { checkout, exists: false, threadIds, blockers };
    const revision = yield* adopt(checkout.projectId, checkout.path).pipe(Effect.result);
    if (Result.isFailure(revision)) {
      blockers.push({
        code: "invalid_checkout",
        message: "This checkout or its project has changed. Relink it before archiving.",
      });
      return { checkout, exists, threadIds, blockers };
    }
    if (key(revision.success.path) !== key(checkout.path))
      blockers.push({
        code: "invalid_checkout",
        message: "The checkout path now points to a different directory.",
      });
    if (verifyRevision && revision.success.branch !== checkout.branch)
      blockers.push({
        code: "changed_branch",
        message: "The checkout branch changed during the workspace operation.",
      });
    if (verifyRevision && revision.success.headCommit !== checkout.headCommit)
      blockers.push({
        code: "changed_head",
        message: "The checkout has new commits since this operation began.",
      });
    const changed = yield* output(checkout.path, [
      "-c",
      "status.showUntrackedFiles=all",
      "status",
      "--porcelain=v1",
      "-z",
      "--ignore-submodules=none",
      "--untracked-files=all",
    ]);
    if (changed.length > 0)
      blockers.push({
        code: "local_changes",
        message: "Commit, copy, or remove local changes and untracked files before archiving.",
      });
    const ignored = yield* output(checkout.path, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "--no-empty-directory",
      "-z",
      "--",
      ".",
      ":!:node_modules",
      ":!:**/node_modules",
    ]);
    const ignoredPaths = ignored.split("\0").filter(Boolean);
    let hasIgnoredFiles = ignoredPaths.some((entry) => entry !== ".t3/");
    if (ignoredPaths.includes(".t3/")) {
      const names = yield* fs.readDirectory(path.join(checkout.path, ".t3"));
      hasIgnoredFiles ||= names.some(
        (name) => !["setup-done", "setup-failed", "setup-running"].includes(name),
      );
    }
    if (hasIgnoredFiles)
      blockers.push({
        code: "ignored_files",
        message:
          "Copy or remove ignored local files before archiving. Installed node_modules can be recreated.",
      });
    return { checkout: revision.success, exists, threadIds, blockers };
  }, Effect.mapError(operationError));

  const archive = Effect.fn("NamedWorkspaceRuntime.archive")(function* (input: {
    readonly checkout: NamedWorkspaceCheckout;
    readonly threadIds: readonly ThreadId[];
    readonly commandId: CommandId;
  }) {
    const before = yield* inspect(input.checkout, true);
    if (before.blockers[0])
      return yield* new NamedWorkspaceError({
        reason: "blocked",
        message: before.blockers[0].message,
      });
    for (const threadId of input.threadIds) {
      const shell = yield* threads.getThreadShell(threadId);
      if (
        shell === null ||
        shell.worktreePath === null ||
        key(shell.worktreePath) !== key(input.checkout.path)
      )
        continue;
      const records = yield* threads.getThreadRecords(threadId, ["providerSessions"]);
      for (const session of records.providerSessions) {
        yield* sessions.detach({ providerSessionId: session.id, threadId });
      }
      yield* terminals.closeIdle({ threadId });
      if (shell.archivedAt === null)
        yield* lifecycle.dispatch({
          type: "thread.archive",
          commandId: CommandId.make(`${input.commandId}:${threadId}:archive`),
          threadId,
        });
    }
    const rechecked = yield* inspect(input.checkout, true);
    if (rechecked.blockers[0])
      return yield* new NamedWorkspaceError({
        reason: "blocked",
        message: rechecked.blockers[0].message,
      });
    if (rechecked.exists) {
      const owner = yield* project(input.checkout.projectId);
      yield* git.removeWorktree({
        cwd: owner.workspaceRoot,
        path: input.checkout.path,
        force: false,
      });
    }
  }, Effect.mapError(operationError));

  const restore = Effect.fn("NamedWorkspaceRuntime.restore")(function* (input: {
    readonly checkout: NamedWorkspaceCheckout;
    readonly threadIds: readonly ThreadId[];
    readonly commandId: CommandId;
  }) {
    const owner = yield* project(input.checkout.projectId);
    const branchHead = (yield* output(owner.workspaceRoot, [
      "rev-parse",
      "--verify",
      `refs/heads/${input.checkout.branch}`,
    ])).trim();
    if (branchHead !== input.checkout.headCommit)
      return yield* new NamedWorkspaceError({
        reason: "blocked",
        message:
          "The saved branch changed after archive. Review it before restoring this workspace.",
      });
    if (yield* fs.exists(input.checkout.path)) {
      const checked = yield* adopt(input.checkout.projectId, input.checkout.path);
      if (
        key(checked.path) !== key(input.checkout.path) ||
        checked.branch !== input.checkout.branch ||
        checked.headCommit !== input.checkout.headCommit
      )
        return yield* new NamedWorkspaceError({
          reason: "blocked",
          message: "The checkout path is now used by different work.",
        });
    } else {
      yield* git.createWorktree({
        cwd: owner.workspaceRoot,
        refName: input.checkout.branch,
        path: input.checkout.path,
      });
    }
    for (const threadId of input.threadIds) {
      const shell = yield* threads.getThreadShell(threadId);
      if (
        shell?.worktreePath &&
        key(shell.worktreePath) === key(input.checkout.path) &&
        shell.archivedAt !== null
      ) {
        yield* lifecycle.dispatch({
          type: "thread.unarchive",
          commandId: CommandId.make(`${input.commandId}:${threadId}:restore`),
          threadId,
        });
      }
    }
  }, Effect.mapError(operationError));

  return NamedWorkspaceRuntime.of({
    members,
    archiveThreads,
    restoreThreads,
    matchingBranches,
    checkoutBranch,
    threadCheckout,
    adopt,
    inspect,
    archive,
    restore,
  });
});

export const layer = Layer.effect(NamedWorkspaceRuntime, make);
