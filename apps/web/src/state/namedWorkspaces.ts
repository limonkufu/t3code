import { useAtomValue } from "@effect/atom-react";
import {
  selectSpaceCheckout,
  createNamedWorkspaceAtoms,
  filterWorkspaceThreads,
  projectWorkspaceThreadPlacements,
  revealThreadWorkspace,
  workspaceCheckoutFilter,
  workspaceScopeKey,
  type WorkspaceScope,
} from "@t3tools/client-runtime/state/namedWorkspaces";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentPresentations } from "./presentation";
import { Atom, AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";
import {
  CommandId,
  EnvironmentId,
  NamedWorkspaceId,
  type NamedWorkspaceMutation,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  useLocalStorage,
  getLocalStorageItem,
  writeLocalStorageValue,
} from "../hooks/useLocalStorage";
import { useRouter } from "@tanstack/react-router";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { threadEnvironment } from "./threads";
import { useAtomCommand } from "./use-atom-command";
import { useOrchestrationCommand } from "./use-orchestration-command";
import { randomUUID } from "../lib/utils";
import { useEffect, useRef } from "react";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { useQuietThreadShell, readThreadShells } from "./entities";
import { useComposerDraftStore } from "../composerDraftStore";

export const namedWorkspaces = createNamedWorkspaceAtoms(
  connectionAtomRuntime,
  environmentPresentations.serverConfigsAtom,
);
export const workspaceManagerOpenAtom = Atom.make(false).pipe(Atom.keepAlive);
const Scope = Schema.NullOr(
  Schema.Struct({ environmentId: EnvironmentId, workspaceId: NamedWorkspaceId }),
);
const Navigation = Schema.Struct({ href: Schema.String, scrollTop: Schema.Number });
const navigationKey = (scope: WorkspaceScope | null) =>
  scope === null ? "all" : workspaceScopeKey(scope);
const navigationStorageKey = (key: string) => `t3code:workspace-navigation:v1:${key}`;
const checkoutStorageKey = (scope: WorkspaceScope) =>
  `t3code:workspace-checkout:v1:${workspaceScopeKey(scope)}`;
function readNavigation(key: string) {
  try {
    return getLocalStorageItem(navigationStorageKey(key), Navigation);
  } catch {
    return null;
  }
}
export function workspaceScrollOffset(scopeKey: string) {
  return readNavigation(scopeKey)?.scrollTop;
}
export function rememberWorkspaceNavigation(
  scope: WorkspaceScope | null,
  href: string,
  scrollTop: number,
) {
  writeLocalStorageValue(
    navigationStorageKey(navigationKey(scope)),
    { href, scrollTop },
    { href: "/", scrollTop: 0 },
    Navigation,
  );
}
export function useWorkspaceNavigation() {
  const [scope, setScope] = useWorkspaceScope();
  const router = useRouter();
  return [
    scope,
    (next: WorkspaceScope | null) => {
      if (navigationKey(next) === navigationKey(scope)) return;
      const viewport = document
        .querySelector('[data-app-sidebar] [data-sidebar="content"]')
        ?.closest('[data-slot="scroll-area-viewport"]');
      rememberWorkspaceNavigation(scope, router.state.location.href, viewport?.scrollTop ?? 0);
      const previous = readNavigation(navigationKey(next));
      const candidates = filterWorkspaceThreads(
        readThreadShells(),
        appAtomRegistry.get(namedWorkspaces.catalogAtom),
        next,
        true,
      );
      const first = candidates.find(
        (thread) => thread.archivedAt === null && thread.deletedAt === null,
      );
      const previousThread = candidates.some(
        (thread) =>
          previous?.href.split("?")[0] === `/${thread.environmentId}/${thread.id}` &&
          thread.deletedAt === null &&
          thread.archivedAt === null,
      );
      const previousDraft = previous?.href.startsWith("/draft/")
        ? useComposerDraftStore
            .getState()
            .getDraftSession(
              previous.href
                .slice("/draft/".length)
                .split("?")[0] as import("../composerDraftStore").DraftId,
            )
        : null;
      const draftBelongs =
        previousDraft !== null &&
        workspaceCheckoutFilter(
          appAtomRegistry.get(namedWorkspaces.catalogAtom),
          next,
          true,
        )(previousDraft);
      const href =
        previous && (previousThread || draftBelongs)
          ? previous.href
          : first
            ? `/${first.environmentId}/${first.id}`
            : null;
      setScope(next);
      if (href) void router.navigate({ to: href });
    },
  ] as const;
}

export function useWorkspaceRouteNavigation() {
  const [scope, setScope] = useWorkspaceScope();
  const [includeOwned] = useIncludeWorkspaceThreads();
  const workspaces = useAtomValue(namedWorkspaces.catalogAtom);
  const ready = useAtomValue(namedWorkspaces.readyEnvironmentIdsAtom);
  const route = useThreadRouteTarget();
  const shell = useQuietThreadShell(route?.kind === "server" ? route.threadRef : null);
  const draft = useComposerDraftStore((store) =>
    route?.kind === "draft" ? store.getDraftSession(route.draftId) : null,
  );
  const thread = route?.kind === "server" ? shell : draft;
  const router = useRouter();
  const href = router.state.location.href;
  const pathname = router.state.location.pathname;
  const expectedPath =
    route?.kind === "server"
      ? `/${route.threadRef.environmentId}/${route.threadRef.threadId}`
      : route?.kind === "draft"
        ? `/draft/${route.draftId}`
        : null;
  const observed = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- external router navigation reveals its thread's workspace and persists device-local navigation
  useEffect(() => {
    if (
      !thread ||
      pathname !== expectedPath ||
      !ready.has(thread.environmentId) ||
      observed.current === href
    )
      return;
    observed.current = href;
    const next = revealThreadWorkspace(thread, workspaces, scope, includeOwned);
    if (navigationKey(next) !== navigationKey(scope)) setScope(next);
    rememberWorkspaceNavigation(next, href, readNavigation(navigationKey(next))?.scrollTop ?? 0);
    const owner = workspaces.find(
      (entry) =>
        entry.environmentId === thread.environmentId &&
        entry.workspace.checkouts.some((checkout) => checkout.path === thread.worktreePath),
    );
    if (owner && thread.worktreePath) {
      const ref = { environmentId: owner.environmentId, workspaceId: owner.workspace.id };
      writeLocalStorageValue(checkoutStorageKey(ref), thread.worktreePath, "", Schema.String);
    }
  }, [href, pathname, expectedPath, thread, workspaces, ready, scope, includeOwned, setScope]);
}

export function readWorkspaceNewThreadCheckout(projectRef?: {
  readonly environmentId: EnvironmentId;
  readonly projectId: import("@t3tools/contracts").ProjectId;
}) {
  const scope = readWorkspaceScope();
  if (scope === null) return null;
  const workspace = appAtomRegistry
    .get(namedWorkspaces.catalogAtom)
    .find(
      (entry) =>
        entry.environmentId === scope.environmentId && entry.workspace.id === scope.workspaceId,
    )?.workspace;
  if (!workspace || workspace.status !== "active") return null;
  let previous: string | null = null;
  try {
    previous = getLocalStorageItem(checkoutStorageKey(scope), Schema.String);
  } catch {
    /* Corrupt local preferences fall back to an owned checkout. */
  }
  if (projectRef && scope.environmentId !== projectRef.environmentId) return null;
  const candidates = filterWorkspaceThreads(
    readThreadShells(),
    appAtomRegistry.get(namedWorkspaces.catalogAtom),
    scope,
    true,
  ).filter(
    (thread) =>
      thread.deletedAt === null &&
      thread.archivedAt === null &&
      (!projectRef || thread.projectId === projectRef.projectId),
  );
  const lastHref = readNavigation(navigationKey(scope))?.href.split("?")[0];
  const lastThread =
    candidates.find((thread) => `/${thread.environmentId}/${thread.id}` === lastHref) ??
    candidates.find((thread) => thread.worktreePath === previous);
  if (lastThread)
    return {
      environmentId: scope.environmentId,
      projectId: lastThread.projectId,
      branch: lastThread.branch,
      path: lastThread.worktreePath,
    };
  const checkout = selectSpaceCheckout(workspace, previous, projectRef?.projectId);
  if (!checkout && candidates[0])
    return {
      environmentId: scope.environmentId,
      projectId: candidates[0].projectId,
      branch: candidates[0].branch,
      path: candidates[0].worktreePath,
    };
  return checkout ? { ...checkout, environmentId: scope.environmentId } : null;
}

export function useWorkspaceScope() {
  const [scope, setScope] = useLocalStorage("t3code:workspace-scope:v1", null, Scope);
  const configs = useAtomValue(environmentPresentations.serverConfigsAtom);
  return [
    scope !== null && configs.get(scope.environmentId)?.namedWorkspaces ? scope : null,
    setScope,
  ] as const;
}
export function useIncludeWorkspaceThreads() {
  return useLocalStorage("t3code:workspace-threads:v1", true, Schema.Boolean);
}

export function useWorkspaceRailExpanded() {
  return useLocalStorage("t3code:workspace-rail-expanded:v1", true, Schema.Boolean);
}

export function useWorkspaceCheckoutFilter() {
  const workspaces = useAtomValue(namedWorkspaces.catalogAtom);
  const [scope] = useWorkspaceScope();
  const [includeOwned] = useIncludeWorkspaceThreads();
  return workspaceCheckoutFilter(workspaces, scope, includeOwned);
}

export function useWorkspaceScopedThreads(threads: readonly EnvironmentThreadShell[]) {
  const workspaces = useAtomValue(namedWorkspaces.catalogAtom);
  const [scope] = useWorkspaceScope();
  const [includeOwned] = useIncludeWorkspaceThreads();
  return projectWorkspaceThreadPlacements(
    filterWorkspaceThreads(threads, workspaces, scope, includeOwned),
    workspaces,
    scope,
  );
}

export function readWorkspaceScope() {
  try {
    return getLocalStorageItem("t3code:workspace-scope:v1", Scope);
  } catch {
    return null;
  }
}

function workspacePreferenceKey(key: string, scope: WorkspaceScope | null) {
  return scope === null ? key : `${key}:workspace:${workspaceScopeKey(scope)}`;
}

export function useWorkspacePreference<T, E>(key: string, initial: T, schema: Schema.Codec<T, E>) {
  return useLocalStorage(workspacePreferenceKey(key, useWorkspaceScope()[0]), initial, schema);
}

export function readWorkspaceThreads(
  threads: readonly EnvironmentThreadShell[],
  scope = readWorkspaceScope(),
) {
  const workspaces = appAtomRegistry.get(namedWorkspaces.catalogAtom);
  return projectWorkspaceThreadPlacements(
    filterWorkspaceThreads(threads, workspaces, scope, true),
    workspaces,
    scope,
  );
}

export function useWorkspacePlacementCommands() {
  const [scope] = useWorkspaceScope();
  const mutate = useAtomCommand(namedWorkspaces.mutate, { reportFailure: false });
  const pin = useOrchestrationCommand(threadEnvironment.pin, { reportFailure: false });
  const unpin = useOrchestrationCommand(threadEnvironment.unpin, { reportFailure: false });
  const reorderPin = useOrchestrationCommand(threadEnvironment.reorderPin, {
    reportFailure: false,
  });
  const reorderActive = useOrchestrationCommand(threadEnvironment.reorderActive, {
    reportFailure: false,
  });
  const change = async (
    target: ScopedThreadRef,
    action: "pin-thread" | "unpin-thread" | "reorder-pinned-thread" | "reorder-active-thread",
    orderKey?: string,
  ) => {
    if (!scope || scope.environmentId !== target.environmentId) return null;
    const input: NamedWorkspaceMutation =
      action === "pin-thread"
        ? {
            type: action,
            threadId: target.threadId,
            orderKey,
            workspaceId: scope.workspaceId,
            commandId: CommandId.make(randomUUID()),
          }
        : action === "unpin-thread"
          ? {
              type: action,
              threadId: target.threadId,
              workspaceId: scope.workspaceId,
              commandId: CommandId.make(randomUUID()),
            }
          : {
              type: action,
              threadId: target.threadId,
              orderKey: orderKey ?? "",
              workspaceId: scope.workspaceId,
              commandId: CommandId.make(randomUUID()),
            };
    return placementResult(await mutate({ environmentId: target.environmentId, input }));
  };
  return {
    pin: async (value: Parameters<typeof pin>[0]) =>
      (await change(
        { environmentId: value.environmentId, threadId: value.input.threadId },
        "pin-thread",
        value.input.orderKey,
      )) ?? placementResult(await pin(value)),
    unpin: async (value: Parameters<typeof unpin>[0]) =>
      (await change(
        { environmentId: value.environmentId, threadId: value.input.threadId },
        "unpin-thread",
      )) ?? placementResult(await unpin(value)),
    reorderPin: async (value: Parameters<typeof reorderPin>[0]) =>
      (await change(
        { environmentId: value.environmentId, threadId: value.input.threadId },
        "reorder-pinned-thread",
        value.input.orderKey,
      )) ?? placementResult(await reorderPin(value)),
    reorderActive: async (value: Parameters<typeof reorderActive>[0]) =>
      (await change(
        { environmentId: value.environmentId, threadId: value.input.threadId },
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

export type SpaceAssignmentTarget =
  | {
      readonly environmentId: EnvironmentId;
      readonly threadId: import("@t3tools/contracts").ThreadId;
    }
  | {
      readonly environmentId: EnvironmentId;
      readonly draftId: import("../composerDraftStore").DraftId;
    };
export const spaceAssignmentTargetAtom = Atom.make<SpaceAssignmentTarget | null>(null).pipe(
  Atom.keepAlive,
);
