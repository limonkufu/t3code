import { resolveThreadSpaceId } from "@t3tools/shared/threadSpace";
import {
  type EnvironmentId,
  type NamedWorkspace,
  type NamedWorkspaceId,
  type ServerConfig,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export interface WorkspaceScope {
  readonly environmentId: EnvironmentId;
  readonly workspaceId: NamedWorkspaceId;
}

export interface ScopedNamedWorkspace {
  readonly environmentId: EnvironmentId;
  readonly workspace: NamedWorkspace;
}

export const workspaceScopeKey = (scope: WorkspaceScope) =>
  JSON.stringify([scope.environmentId, scope.workspaceId]);

export function projectWorkspaceThreadPlacements<
  T extends {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
    readonly pinnedAt?: string | null;
    readonly pinOrderKey?: string | null;
    readonly activeOrderKey?: string | null;
  },
>(
  threads: readonly T[],
  workspaces: readonly ScopedNamedWorkspace[],
  scope: WorkspaceScope | null,
): readonly T[] {
  if (scope === null) return threads;
  const workspace = workspaces.find(
    (entry) =>
      entry.environmentId === scope.environmentId && entry.workspace.id === scope.workspaceId,
  )?.workspace;
  const placements = new Map(workspace?.threadPlacements.map((item) => [item.threadId, item]));
  return threads.map((thread) => {
    const placement =
      thread.environmentId === scope.environmentId ? placements.get(thread.id) : undefined;
    return {
      ...thread,
      pinnedAt: placement?.pinnedAt ?? null,
      pinOrderKey: placement?.pinOrderKey ?? null,
      activeOrderKey: placement?.activeOrderKey ?? null,
    };
  });
}

export function revealThreadWorkspace(
  thread: {
    readonly environmentId: EnvironmentId;
    readonly spaceId?: NamedWorkspaceId | null | undefined;
    readonly worktreePath: string | null;
  },
  workspaces: readonly ScopedNamedWorkspace[],
  scope: WorkspaceScope | null,
  includeWorkspaceThreads: boolean,
): WorkspaceScope | null {
  if (workspaceCheckoutFilter(workspaces, scope, includeWorkspaceThreads)(thread)) return scope;
  const spaceId = resolveThreadSpaceId(
    thread,
    workspaces
      .filter((entry) => entry.environmentId === thread.environmentId)
      .map((entry) => entry.workspace),
  );
  return spaceId === null ? null : { environmentId: thread.environmentId, workspaceId: spaceId };
}

export function selectSpaceCheckout(
  space: NamedWorkspace,
  previousPath: string | null,
  projectId?: import("@t3tools/contracts").ProjectId,
) {
  const candidates = projectId
    ? space.checkouts.filter((item) => item.projectId === projectId)
    : space.checkouts;
  return candidates.find((item) => item.path === previousPath) ?? candidates[0] ?? null;
}

export function filterWorkspaceThreads<
  T extends {
    readonly environmentId: EnvironmentId;
    readonly spaceId?: NamedWorkspaceId | null | undefined;
    readonly worktreePath: string | null;
  },
>(
  threads: readonly T[],
  workspaces: readonly ScopedNamedWorkspace[],
  scope: WorkspaceScope | null,
  includeWorkspaceThreads: boolean,
): readonly T[] {
  if (scope === null && includeWorkspaceThreads) return threads;
  return threads.filter(workspaceCheckoutFilter(workspaces, scope, includeWorkspaceThreads));
}

export function workspaceCheckoutFilter(
  workspaces: readonly ScopedNamedWorkspace[],
  scope: WorkspaceScope | null,
  includeWorkspaceThreads: boolean,
) {
  const spacesByEnvironment = new Map<EnvironmentId, NamedWorkspace[]>();
  for (const entry of workspaces) {
    const spaces = spacesByEnvironment.get(entry.environmentId) ?? [];
    spaces.push(entry.workspace);
    spacesByEnvironment.set(entry.environmentId, spaces);
  }
  return (thread: {
    readonly environmentId: EnvironmentId;
    readonly spaceId?: NamedWorkspaceId | null | undefined;
    readonly worktreePath: string | null;
  }) => {
    if (scope === null && includeWorkspaceThreads) return true;
    const spaceId = resolveThreadSpaceId(
      thread,
      spacesByEnvironment.get(thread.environmentId) ?? [],
    );
    return scope === null
      ? spaceId === null
      : scope.environmentId === thread.environmentId && scope.workspaceId === spaceId;
  };
}

export function createNamedWorkspaceAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  configs: Atom.Atom<ReadonlyMap<EnvironmentId, Pick<ServerConfig, "namedWorkspaces">>>,
) {
  const subscribe = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "named-workspaces:catalog",
    tag: WS_METHODS.namedWorkspacesSubscribe,
  });
  const catalogAtom = Atom.make((get): readonly ScopedNamedWorkspace[] => {
    const entries: ScopedNamedWorkspace[] = [];
    for (const [environmentId, config] of get(configs)) {
      if (!config.namedWorkspaces) continue;
      const workspaces = AsyncResult.getOrElse(
        get(subscribe({ environmentId, input: {} })),
        () => [],
      );
      for (const workspace of workspaces) entries.push({ environmentId, workspace });
    }
    return [...entries].sort(
      (a, b) =>
        a.environmentId.localeCompare(b.environmentId) ||
        a.workspace.createdAt.localeCompare(b.workspace.createdAt) ||
        a.workspace.id.localeCompare(b.workspace.id),
    );
  }).pipe(Atom.withLabel("named-workspaces:all-environments"));
  const readyEnvironmentIdsAtom = Atom.make(
    (get) =>
      new Set(
        [...get(configs)]
          .filter(
            ([environmentId, config]) =>
              config.namedWorkspaces &&
              AsyncResult.isSuccess(get(subscribe({ environmentId, input: {} }))),
          )
          .map(([environmentId]) => environmentId),
      ),
  );
  return {
    catalogAtom,
    readyEnvironmentIdsAtom,
    scopeAtom: Atom.make<WorkspaceScope | null>(null).pipe(Atom.keepAlive),
    includeOwnedAtom: Atom.make(true).pipe(Atom.keepAlive),
    mutate: createEnvironmentRpcCommand(runtime, {
      label: "named-workspaces:mutate",
      tag: WS_METHODS.namedWorkspacesMutate,
    }),
    previewArchive: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "named-workspaces:preview",
      tag: WS_METHODS.namedWorkspacesPreviewArchive,
      staleTimeMs: 0,
    }),
    suggestions: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "named-workspaces:suggestions",
      tag: WS_METHODS.namedWorkspacesSuggestions,
      staleTimeMs: 0,
    }),
  };
}
