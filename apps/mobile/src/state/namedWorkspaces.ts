import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  createNamedWorkspaceAtoms,
  filterWorkspaceThreads,
  projectWorkspaceThreadPlacements,
  workspaceScopeKey,
  revealThreadWorkspace,
  type WorkspaceScope,
  workspaceCheckoutFilter,
} from "@t3tools/client-runtime/state/namedWorkspaces";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentPresentations } from "./presentation";
import { AsyncResult } from "effect/reactivity";
import {
  CommandId,
  type NamedWorkspaceMutation,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { appAtomRegistry } from "./atom-registry";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "./preferences";
import type { NamedWorkspaceView, Preferences } from "../persistence/mobile-preferences";
import { useAtomCommand } from "./use-atom-command";
import { threadEnvironment, environmentThreadShells } from "./threads";
import { uuidv4 } from "../lib/uuid";

export const namedWorkspaces = createNamedWorkspaceAtoms(
  connectionAtomRuntime,
  environmentPresentations.serverConfigsAtom,
);

function readPreferences(): Preferences {
  const result = appAtomRegistry.get(mobilePreferencesAtom);
  return AsyncResult.isSuccess(result) ? result.value : {};
}
const viewKey = (scope: WorkspaceScope | null) =>
  scope === null ? "all" : workspaceScopeKey(scope);
export function readNamedWorkspaceScope() {
  return readPreferences().namedWorkspaceScope ?? null;
}
export function readNamedWorkspaceView(scope = readNamedWorkspaceScope()) {
  return readPreferences().namedWorkspaceViews?.[viewKey(scope)] ?? {};
}
function updateNamedWorkspaceView(
  patch:
    | Partial<NamedWorkspaceView>
    | ((current: NamedWorkspaceView) => Partial<NamedWorkspaceView>),
  scope = readNamedWorkspaceScope(),
) {
  appAtomRegistry.set(updateMobilePreferencesAtom, {
    transform: (current: Preferences) => ({
      namedWorkspaceViews: {
        ...current.namedWorkspaceViews,
        [viewKey(scope)]: {
          ...current.namedWorkspaceViews?.[viewKey(scope)],
          ...(typeof patch === "function"
            ? patch(current.namedWorkspaceViews?.[viewKey(scope)] ?? {})
            : patch),
        },
      },
    }),
  });
}
export function useNamedWorkspaceScope() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const update = useAtomSet(updateMobilePreferencesAtom);
  const configs = useAtomValue(environmentPresentations.serverConfigsAtom);
  const scope = AsyncResult.isSuccess(preferences)
    ? (preferences.value.namedWorkspaceScope ?? null)
    : null;
  return [
    scope !== null && configs.get(scope.environmentId)?.namedWorkspaces ? scope : null,
    (next: WorkspaceScope | null) => update({ namedWorkspaceScope: next }),
  ] as const;
}
export function useNamedWorkspaceView() {
  const [scope] = useNamedWorkspaceScope();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const view = AsyncResult.isSuccess(preferences)
    ? (preferences.value.namedWorkspaceViews?.[viewKey(scope)] ?? {})
    : {};
  return [
    view,
    (
      patch:
        | Partial<NamedWorkspaceView>
        | ((current: NamedWorkspaceView) => Partial<NamedWorkspaceView>),
    ) => updateNamedWorkspaceView(patch, scope),
  ] as const;
}
export function useIncludeWorkspaceThreads() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const update = useAtomSet(updateMobilePreferencesAtom);
  return [
    !AsyncResult.isSuccess(preferences) || preferences.value.namedWorkspaceIncludeOwned !== false,
    (include: boolean) => update({ namedWorkspaceIncludeOwned: include }),
  ] as const;
}
export function readWorkspaceThreads(
  threads: readonly EnvironmentThreadShell[],
  scope = readNamedWorkspaceScope(),
) {
  const workspaces = appAtomRegistry.get(namedWorkspaces.catalogAtom);
  return projectWorkspaceThreadPlacements(
    filterWorkspaceThreads(
      threads,
      workspaces,
      scope,
      readPreferences().namedWorkspaceIncludeOwned !== false,
    ),
    workspaces,
    scope,
  );
}
export function useWorkspaceScopedThreads(threads: readonly EnvironmentThreadShell[]) {
  const workspaces = useAtomValue(namedWorkspaces.catalogAtom);
  const [scope] = useNamedWorkspaceScope();
  const [include] = useIncludeWorkspaceThreads();
  return projectWorkspaceThreadPlacements(
    filterWorkspaceThreads(threads, workspaces, scope, include),
    workspaces,
    scope,
  );
}
export function revealNamedWorkspaceThread(environmentId: EnvironmentId, threadId: ThreadId) {
  const thread = appAtomRegistry
    .get(environmentThreadShells.threadShellsAtom)
    .find((item) => item.environmentId === environmentId && item.id === threadId);
  if (!thread) return;
  const workspaces = appAtomRegistry.get(namedWorkspaces.catalogAtom);
  const scope = revealThreadWorkspace(
    thread,
    workspaces,
    readNamedWorkspaceScope(),
    readPreferences().namedWorkspaceIncludeOwned !== false,
  );
  appAtomRegistry.set(updateMobilePreferencesAtom, { namedWorkspaceScope: scope });
  updateNamedWorkspaceView({ lastThread: { environmentId, threadId } }, scope);
  const owner = workspaces.find(
    (entry) =>
      entry.environmentId === environmentId &&
      entry.workspace.checkouts.some((checkout) => checkout.path === thread.worktreePath),
  );
  if (owner && thread.worktreePath)
    updateNamedWorkspaceView(
      { lastCheckout: thread.worktreePath },
      { environmentId, workspaceId: owner.workspace.id },
    );
}
export function readWorkspaceNewThreadCheckout() {
  const scope = readNamedWorkspaceScope();
  if (!scope) return null;
  const workspace = appAtomRegistry
    .get(namedWorkspaces.catalogAtom)
    .find(
      (entry) =>
        entry.environmentId === scope.environmentId && entry.workspace.id === scope.workspaceId,
    )?.workspace;
  if (!workspace || workspace.status !== "active") return null;
  const previous = readNamedWorkspaceView(scope);
  const candidates = filterWorkspaceThreads(
    appAtomRegistry.get(environmentThreadShells.threadShellsAtom),
    appAtomRegistry.get(namedWorkspaces.catalogAtom),
    scope,
    true,
  ).filter((thread) => thread.deletedAt === null && thread.archivedAt === null);
  const lastThread = candidates.find(
    (thread) =>
      thread.id === previous.lastThread?.threadId &&
      thread.environmentId === previous.lastThread.environmentId,
  );
  if (lastThread)
    return {
      environmentId: scope.environmentId,
      projectId: lastThread.projectId,
      branch: lastThread.branch,
      path: lastThread.worktreePath,
    };
  const checkout =
    workspace.checkouts.find((item) => item.path === previous.lastCheckout) ??
    workspace.checkouts[0];
  if (!checkout && candidates[0])
    return {
      environmentId: scope.environmentId,
      projectId: candidates[0].projectId,
      branch: candidates[0].branch,
      path: candidates[0].worktreePath,
    };
  return checkout ? { ...checkout, environmentId: scope.environmentId } : null;
}
export function useWorkspacePlacementCommands() {
  const [scope] = useNamedWorkspaceScope();
  const mutate = useAtomCommand(namedWorkspaces.mutate, { reportFailure: false });
  const pin = useAtomCommand(threadEnvironment.pin, { reportFailure: false });
  const unpin = useAtomCommand(threadEnvironment.unpin, { reportFailure: false });
  const reorderPin = useAtomCommand(threadEnvironment.reorderPin, { reportFailure: false });
  const reorderActive = useAtomCommand(threadEnvironment.reorderActive, { reportFailure: false });
  const change = async (
    environmentId: EnvironmentId,
    threadId: ThreadId,
    action: "pin-thread" | "unpin-thread" | "reorder-pinned-thread" | "reorder-active-thread",
    orderKey?: string,
  ) => {
    if (!scope || scope.environmentId !== environmentId) return null;
    const command = {
      workspaceId: scope.workspaceId,
      commandId: CommandId.make(uuidv4()),
      threadId,
    };
    const input: NamedWorkspaceMutation =
      action === "pin-thread"
        ? { ...command, type: action, orderKey }
        : action === "unpin-thread"
          ? { ...command, type: action }
          : { ...command, type: action, orderKey: orderKey ?? "" };
    return placementResult(await mutate({ environmentId, input }));
  };
  return {
    pin: async (value: Parameters<typeof pin>[0]) =>
      (await change(
        value.environmentId,
        value.input.threadId,
        "pin-thread",
        value.input.orderKey,
      )) ?? placementResult(await pin(value)),
    unpin: async (value: Parameters<typeof unpin>[0]) =>
      (await change(value.environmentId, value.input.threadId, "unpin-thread")) ??
      placementResult(await unpin(value)),
    reorderPin: async (value: Parameters<typeof reorderPin>[0]) =>
      (await change(
        value.environmentId,
        value.input.threadId,
        "reorder-pinned-thread",
        value.input.orderKey,
      )) ?? placementResult(await reorderPin(value)),
    reorderActive: async (value: Parameters<typeof reorderActive>[0]) =>
      (await change(
        value.environmentId,
        value.input.threadId,
        "reorder-active-thread",
        value.input.orderKey,
      )) ?? placementResult(await reorderActive(value)),
  };
}
function placementResult<A, E>(
  result: import("@t3tools/client-runtime/state/runtime").AtomCommandResult<A, E>,
) {
  return result._tag === "Failure" ? result : AsyncResult.success(undefined);
}

export function useWorkspaceScopedPendingTasks(
  tasks: readonly import("./pending-new-tasks-model").PendingNewTask[],
) {
  const matches = workspaceCheckoutFilter(
    useAtomValue(namedWorkspaces.catalogAtom),
    useNamedWorkspaceScope()[0],
    useIncludeWorkspaceThreads()[0],
  );
  return tasks.filter((task) =>
    matches({
      environmentId: task.environmentId,
      spaceId: task.kind === "pending" ? task.creation.spaceId : task.draft.spaceId,
      worktreePath:
        task.kind === "pending"
          ? task.creation.worktreePath
          : (task.draft.workspaceSelection?.worktreePath ?? null),
    }),
  );
}

const scrollWrites = new Map<string, ReturnType<typeof setTimeout>>();
export function saveNamedWorkspaceScroll(scrollOffset: number, scope = readNamedWorkspaceScope()) {
  const key = viewKey(scope);
  clearTimeout(scrollWrites.get(key));
  scrollWrites.set(
    key,
    setTimeout(() => {
      scrollWrites.delete(key);
      updateNamedWorkspaceView({ scrollOffset }, scope);
    }, 160),
  );
}
export function useWorkspaceThreadPlacements(threads: readonly EnvironmentThreadShell[]) {
  return projectWorkspaceThreadPlacements(
    threads,
    useAtomValue(namedWorkspaces.catalogAtom),
    useNamedWorkspaceScope()[0],
  );
}
