import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuSeparator,
  MenuRadioGroup,
  MenuRadioItem,
  MenuCheckboxItem,
} from "./ui/menu";
import { useAtom, useAtomValue } from "@effect/atom-react";
import {
  filterWorkspaceThreads,
  workspaceScopeKey,
  type ScopedNamedWorkspace,
} from "@t3tools/client-runtime/state/namedWorkspaces";
import { CommandId, NamedWorkspaceId, type NamedWorkspaceMutation } from "@t3tools/contracts";
import {
  ArchiveIcon,
  ChevronDownIcon,
  FolderPlusIcon,
  GitBranchIcon,
  LayersIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PlusIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { cn, randomUUID } from "../lib/utils";
import { useEnvironments } from "../state/environments";
import { useProjects, useQuietThreadShells } from "../state/entities";
import {
  namedWorkspaces,
  workspaceManagerOpenAtom,
  useWorkspaceNavigation,
  useWorkspaceScope,
  useIncludeWorkspaceThreads,
  useWorkspaceRailExpanded,
} from "../state/namedWorkspaces";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { vcsEnvironment } from "../state/vcs";
import { resolveSidebarFolderDot } from "./Sidebar.logic";
import { Button } from "./ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "./ui/dialog";
import { ScrollArea } from "./ui/scroll-area";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";
import { Input } from "./ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";

function WorkspaceRailButton({
  label,
  selected,
  onClick,
  children,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={selected}
            onClick={onClick}
            className={cn(
              "relative flex size-9 shrink-0 items-center justify-center rounded-lg text-xs font-medium text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring",
              selected && "bg-accent text-foreground ring-1 ring-sidebar-border",
            )}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="right">{label}</TooltipPopup>
    </Tooltip>
  );
}

export function NamedWorkspaceRail() {
  const workspaces = useAtomValue(namedWorkspaces.catalogAtom);
  const [railExpanded] = useWorkspaceRailExpanded();
  const [scope, setScope] = useWorkspaceNavigation();
  const [, setManagerOpen] = useAtom(workspaceManagerOpenAtom);
  const threads = useQuietThreadShells();
  if (workspaces.length === 0 || !railExpanded) return null;
  return (
    <nav aria-label="Spaces" className="w-12 shrink-0 border-r border-sidebar-border bg-sidebar">
      <ScrollArea hideScrollbars className="h-full">
        <div className="flex flex-col items-center gap-2 pt-(--workspace-topbar-height) pb-3">
          <WorkspaceRailButton
            label="All threads"
            selected={scope === null}
            onClick={() => setScope(null)}
          >
            <LayersIcon className="size-4" />
          </WorkspaceRailButton>
          <div className="my-1 h-px w-5 bg-sidebar-border" />
          {workspaces
            .filter(({ workspace }) => workspace.status !== "archived")
            .map((entry) => {
              const ref = { environmentId: entry.environmentId, workspaceId: entry.workspace.id };
              const selected =
                scope !== null && workspaceScopeKey(scope) === workspaceScopeKey(ref);
              const dot = resolveSidebarFolderDot(
                filterWorkspaceThreads(threads, [entry], ref, true),
              );
              return (
                <WorkspaceRailButton
                  key={workspaceScopeKey(ref)}
                  label={`${entry.workspace.name}${dot ? `, ${dot}` : ""}`}
                  selected={selected}
                  onClick={() => setScope(ref)}
                >
                  {(entry.workspace.name.trim().split(/\s+/).length > 1
                    ? [
                        entry.workspace.name.trim().split(/\s+/)[0]?.[0],
                        entry.workspace.name.trim().split(/\s+/).at(-1)?.[0],
                      ]
                        .filter(Boolean)
                        .join("")
                    : entry.workspace.name.slice(0, 2)
                  ).toUpperCase()}
                  {(dot || entry.workspace.lastError) && (
                    <span
                      className={cn(
                        "absolute right-0.5 top-0.5 size-1.5 rounded-full",
                        dot === "working"
                          ? "bg-primary"
                          : dot === "failed" || entry.workspace.lastError
                            ? "bg-destructive"
                            : "bg-warning",
                      )}
                    />
                  )}
                </WorkspaceRailButton>
              );
            })}
          <WorkspaceRailButton
            label="Manage Spaces"
            selected={false}
            onClick={() => setManagerOpen(true)}
          >
            <PlusIcon className="size-4" />
          </WorkspaceRailButton>
        </div>
      </ScrollArea>
    </nav>
  );
}

export function NamedWorkspaceScopeHeader() {
  const entries = useAtomValue(namedWorkspaces.catalogAtom);
  const [scope, setScope] = useWorkspaceNavigation();
  const [includeOwned, setIncludeOwned] = useIncludeWorkspaceThreads();
  const [railExpanded, setRailExpanded] = useWorkspaceRailExpanded();
  const [open, setOpen] = useAtom(workspaceManagerOpenAtom);
  const { environments } = useEnvironments();
  const selected = entries.find(
    (entry) =>
      scope &&
      entry.environmentId === scope.environmentId &&
      entry.workspace.id === scope.workspaceId,
  );
  if (!environments.some((environment) => environment.serverConfig?.namedWorkspaces)) return null;
  return (
    <>
      <div className="flex min-w-0 items-center justify-between gap-1 px-3 pb-1">
        {entries.length === 0 ? (
          <Button variant="ghost-muted" size="compact" onClick={() => setOpen(true)}>
            <FolderPlusIcon />
            Create Space
          </Button>
        ) : (
          <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)]">
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    variant="ghost-muted"
                    size="compact"
                    aria-label="Choose Space view"
                    title={selected?.workspace.name ?? "All threads"}
                  />
                }
              >
                <LayersIcon />
                <span className="min-w-0 truncate">
                  {selected?.workspace.name ?? "All threads"}
                </span>
                <ChevronDownIcon />
              </MenuTrigger>
              <MenuPopup align="start">
                <MenuRadioGroup
                  value={
                    selected
                      ? workspaceScopeKey({
                          environmentId: selected.environmentId,
                          workspaceId: selected.workspace.id,
                        })
                      : "all"
                  }
                  onValueChange={(key) => {
                    const entry = entries.find(
                      (item) =>
                        workspaceScopeKey({
                          environmentId: item.environmentId,
                          workspaceId: item.workspace.id,
                        }) === key,
                    );
                    setScope(
                      entry
                        ? { environmentId: entry.environmentId, workspaceId: entry.workspace.id }
                        : null,
                    );
                  }}
                >
                  <MenuRadioItem value="all">All threads</MenuRadioItem>
                  {entries
                    .filter((entry) => entry.workspace.status === "active")
                    .map((entry) => (
                      <MenuRadioItem
                        key={workspaceScopeKey({
                          environmentId: entry.environmentId,
                          workspaceId: entry.workspace.id,
                        })}
                        value={workspaceScopeKey({
                          environmentId: entry.environmentId,
                          workspaceId: entry.workspace.id,
                        })}
                      >
                        {entry.workspace.name}
                      </MenuRadioItem>
                    ))}
                </MenuRadioGroup>
                <MenuSeparator />
                {!scope && (
                  <MenuCheckboxItem checked={includeOwned} onCheckedChange={setIncludeOwned}>
                    Include Space threads
                  </MenuCheckboxItem>
                )}
                <MenuItem onClick={() => setOpen(true)}>Manage Spaces…</MenuItem>
              </MenuPopup>
            </Menu>
          </div>
        )}
        {entries.length > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost-muted"
                  size="icon-xs"
                  aria-label={railExpanded ? "Collapse Space rail" : "Show Space rail"}
                  aria-expanded={railExpanded}
                  onClick={() => setRailExpanded(!railExpanded)}
                />
              }
            >
              {railExpanded ? <PanelLeftCloseIcon /> : <PanelLeftOpenIcon />}
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {railExpanded ? "Collapse Space rail" : "Show Space rail"}
            </TooltipPopup>
          </Tooltip>
        )}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Spaces</DialogTitle>
            <DialogDescription>Keep related threads together across projects.</DialogDescription>
          </DialogHeader>
          {open && (
            <WorkspaceManager
              initialKey={
                selected
                  ? workspaceScopeKey({
                      environmentId: selected.environmentId,
                      workspaceId: selected.workspace.id,
                    })
                  : null
              }
            />
          )}
        </DialogPopup>
      </Dialog>
    </>
  );
}

function WorkspaceManager({ initialKey }: { initialKey: string | null }) {
  const threads = useQuietThreadShells();
  const entries = useAtomValue(namedWorkspaces.catalogAtom);
  const { environments } = useEnvironments();
  const supported = environments.filter(
    (environment) =>
      environment.serverConfig?.namedWorkspaces && environment.connection.phase === "connected",
  );
  const [selectedKey, setSelectedKey] = useState(initialKey);
  const [hostId, setHostId] = useState(supported[0]?.environmentId ?? null);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const mutate = useAtomCommand(namedWorkspaces.mutate);
  const canCreate = useAtomValue(namedWorkspaces.mutate.permissionAtom(hostId));
  const selected = entries.find(
    (entry) =>
      workspaceScopeKey({ environmentId: entry.environmentId, workspaceId: entry.workspace.id }) ===
      selectedKey,
  );
  if (selected)
    return (
      <WorkspaceEditor key={selectedKey} entry={selected} onBack={() => setSelectedKey(null)} />
    );
  return (
    <div className="space-y-5 px-6 pb-6">
      <div className="max-h-64 space-y-1 overflow-y-auto">
        {entries.map((entry) => {
          const threadCount = filterWorkspaceThreads(
            threads,
            [entry],
            { environmentId: entry.environmentId, workspaceId: entry.workspace.id },
            true,
          ).filter((thread) => thread.archivedAt === null).length;
          return (
            <button
              type="button"
              key={workspaceScopeKey({
                environmentId: entry.environmentId,
                workspaceId: entry.workspace.id,
              })}
              onClick={() =>
                setSelectedKey(
                  workspaceScopeKey({
                    environmentId: entry.environmentId,
                    workspaceId: entry.workspace.id,
                  }),
                )
              }
              className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{entry.workspace.name}</span>
                <span className="block text-xs text-muted-foreground">
                  {threadCount} {threadCount === 1 ? "thread" : "threads"} ·{" "}
                  {environments.find((host) => host.environmentId === entry.environmentId)?.label ??
                    "Environment"}
                </span>
              </span>
              <span className="text-xs text-muted-foreground">{entry.workspace.status}</span>
            </button>
          );
        })}
      </div>
      <form
        className="space-y-3 border-t pt-4"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!hostId || !name.trim() || pending) return;
          setPending(true);
          const workspaceId = NamedWorkspaceId.make(randomUUID());
          const result = await mutate({
            environmentId: hostId,
            input: {
              type: "create",
              commandId: CommandId.make(randomUUID()),
              workspaceId,
              name: name.trim(),
            },
          });
          setPending(false);
          if (result._tag === "Success") {
            setName("");
            setSelectedKey(workspaceScopeKey({ environmentId: hostId, workspaceId }));
          }
        }}
      >
        <label className="block space-y-1.5 text-xs font-medium">
          <span>New Space</span>
          <Input
            aria-label="Space name"
            placeholder="Account rollout"
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {supported.length > 1 && (
          <Select
            value={hostId}
            onValueChange={setHostId}
            items={supported.map((environment) => ({
              value: environment.environmentId,
              label: environment.label,
            }))}
          >
            <SelectTrigger aria-label="Environment">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {supported.map((environment) => (
                <SelectItem key={environment.environmentId} value={environment.environmentId}>
                  {environment.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        )}
        <Button type="submit" disabled={!canCreate || pending || !name.trim() || !hostId}>
          <PlusIcon />
          {pending ? "Creating…" : "Create Space"}
        </Button>
      </form>
    </div>
  );
}

function WorkspaceEditor({ entry, onBack }: { entry: ScopedNamedWorkspace; onBack: () => void }) {
  const { workspace, environmentId } = entry;
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [projectId, setProjectId] = useState(projects[0]?.id ?? null);
  const [name, setName] = useState(workspace.name);
  const [path, setPath] = useState("");
  const [branch, setBranch] = useState("");
  const [baseRef, setBaseRef] = useState("HEAD");
  const [newCheckout, setNewCheckout] = useState(false);
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, setScope] = useWorkspaceScope();
  const [, setManagerOpen] = useAtom(workspaceManagerOpenAtom);
  const mutate = useAtomCommand(namedWorkspaces.mutate);
  const createWorktree = useAtomCommand(vcsEnvironment.createWorktree);
  const newThread = useNewThreadHandler();
  const canEdit = useAtomValue(namedWorkspaces.mutate.permissionAtom(environmentId));
  const canManageCheckouts = useAtomValue(
    namedWorkspaces.mutate.permissionAtom(environmentId, {
      type: "archive",
      commandId: CommandId.make("permission"),
      workspaceId: workspace.id,
    }),
  );
  const preview = useEnvironmentQuery(
    review
      ? namedWorkspaces.previewArchive({ environmentId, input: { workspaceId: workspace.id } })
      : null,
  );
  const active = workspace.status === "active";
  const canReleaseCheckout =
    active || workspace.status === "archived" || workspace.lastError !== null;
  const blocked = preview.data?.checkouts.some((checkout) => checkout.blockers.length > 0) ?? true;
  const run = async (input: NamedWorkspaceMutation) => {
    setBusy(true);
    setError(null);
    const result = await mutate({ environmentId, input });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(formatEnvironmentQueryError(result.cause));
      return false;
    }
    if (input.type === "archive") {
      setScope(null);
      setReview(false);
    }
    return true;
  };
  const command = () => ({ commandId: CommandId.make(randomUUID()), workspaceId: workspace.id });
  return (
    <div className="max-h-[65vh] space-y-5 overflow-y-auto px-6 pb-6">
      {!review && (
        <>
          <Button size="compact" variant="ghost-muted" onClick={onBack}>
            ← All Spaces
          </Button>
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim()) void run({ ...command(), type: "rename", name: name.trim() });
            }}
          >
            <label className="min-w-0 flex-1 space-y-1.5 text-xs font-medium">
              <span>Name</span>
              <Input
                value={name}
                maxLength={80}
                aria-label="Space name"
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <Button
              type="submit"
              variant="outline"
              disabled={busy || !canEdit || name.trim() === workspace.name || !name.trim()}
            >
              Save
            </Button>
          </form>
          <details className="space-y-3">
            <summary className="cursor-pointer text-sm text-muted-foreground">
              Checkouts · {workspace.checkouts.length}
            </summary>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-medium text-muted-foreground">Checkouts</h3>
                <span className="text-xs text-muted-foreground">{workspace.status}</span>
              </div>
              {workspace.checkouts.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  Dedicated checkouts are optional. Threads can use a project’s current checkout.
                </p>
              )}
              {workspace.checkouts.map((checkout) => (
                <div
                  key={checkout.path}
                  className="flex items-start justify-between gap-2 border-b border-border py-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 text-sm">
                      <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{checkout.branch}</span>
                    </div>
                    <p className="mt-1 break-all text-xs text-muted-foreground">{checkout.path}</p>
                    <div className="mt-2">
                      <Button
                        size="compact"
                        variant="ghost"
                        disabled={busy || !active || !canEdit}
                        onClick={() => {
                          setScope({ environmentId, workspaceId: workspace.id });
                          setManagerOpen(false);
                          void newThread(
                            { environmentId, projectId: checkout.projectId },
                            {
                              branch: checkout.branch,
                              worktreePath: checkout.path,
                              envMode: "worktree",
                            },
                          );
                        }}
                      >
                        New thread here
                      </Button>
                    </div>
                  </div>
                  {canReleaseCheckout && (
                    <Button
                      size="compact"
                      variant="ghost-muted"
                      disabled={busy || !canEdit}
                      onClick={() =>
                        void run({ ...command(), type: "detach", path: checkout.path })
                      }
                    >
                      Remove
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </details>
          {workspace.associationChoices.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-medium text-muted-foreground">
                Remembered project choices
              </h3>
              {workspace.associationChoices.map((item) => (
                <div
                  key={item.projectId}
                  className="flex items-center justify-between gap-2 text-xs"
                >
                  <span className="min-w-0 truncate">
                    {projects.find((project) => project.id === item.projectId)?.title ??
                      item.projectId}{" "}
                    · {item.choice === "add" ? "Add matching branches" : "Keep separate"}
                  </span>
                  <Button
                    size="compact"
                    variant="ghost-muted"
                    disabled={busy || !canEdit}
                    onClick={() =>
                      void run({
                        ...command(),
                        type: "set-project-association",
                        projectId: item.projectId,
                        choice: null,
                      })
                    }
                  >
                    Ask next time
                  </Button>
                </div>
              ))}
            </div>
          )}
          {active && (
            <details className="space-y-3">
              <summary className="cursor-pointer text-sm text-muted-foreground">
                Add a dedicated checkout…
              </summary>
              <form
                className="space-y-3"
                onSubmit={async (event) => {
                  event.preventDefault();
                  const project = projects.find((candidate) => candidate.id === projectId);
                  if (!project || busy) return;
                  let checkoutPath = path.trim();
                  if (newCheckout) {
                    setBusy(true);
                    const result = await createWorktree({
                      environmentId,
                      input: {
                        cwd: project.workspaceRoot,
                        refName: baseRef.trim() || "HEAD",
                        newRefName: branch.trim(),
                        path: null,
                      },
                    });
                    setBusy(false);
                    if (result._tag !== "Success") return;
                    checkoutPath = result.value.worktree.path;
                    setPath(checkoutPath);
                    setNewCheckout(false);
                  }
                  if (
                    await run({
                      ...command(),
                      type: "attach",
                      projectId: project.id,
                      path: checkoutPath,
                    })
                  ) {
                    setPath("");
                    setBranch("");
                  }
                }}
              >
                <div className="flex gap-2">
                  <Button
                    size="compact"
                    variant={!newCheckout ? "secondary" : "ghost"}
                    onClick={() => setNewCheckout(false)}
                  >
                    Existing worktree
                  </Button>
                  <Button
                    size="compact"
                    variant={newCheckout ? "secondary" : "ghost"}
                    onClick={() => setNewCheckout(true)}
                  >
                    New worktree
                  </Button>
                </div>
                <Select
                  value={projectId}
                  onValueChange={setProjectId}
                  items={projects.map((project) => ({ value: project.id, label: project.title }))}
                >
                  <SelectTrigger aria-label="Project">
                    <SelectValue placeholder="Choose project" />
                  </SelectTrigger>
                  <SelectPopup>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                {newCheckout ? (
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      aria-label="New branch"
                      placeholder="feature/account"
                      value={branch}
                      onChange={(event) => setBranch(event.target.value)}
                    />
                    <Input
                      aria-label="Base branch"
                      value={baseRef}
                      onChange={(event) => setBaseRef(event.target.value)}
                    />
                  </div>
                ) : (
                  <Input
                    aria-label="Worktree path"
                    placeholder="Absolute path to a linked worktree"
                    value={path}
                    onChange={(event) => setPath(event.target.value)}
                  />
                )}
                <p className="text-xs text-muted-foreground">
                  All threads in this checkout join the Space. Archiving removes its directory.
                  Project roots stay protected.
                </p>
                <Button
                  type="submit"
                  variant="outline"
                  disabled={
                    busy ||
                    !canManageCheckouts ||
                    !projectId ||
                    !(newCheckout ? branch.trim() : path.trim())
                  }
                >
                  <FolderPlusIcon />
                  {newCheckout ? "Create and add worktree" : "Add worktree"}
                </Button>
              </form>
            </details>
          )}
        </>
      )}
      {(workspace.lastError || error) && (
        <p role="alert" className="text-sm text-destructive">
          {workspace.lastError ?? error}
        </p>
      )}
      <div className="space-y-3 border-t pt-4">
        {workspace.status === "archived" && workspace.retainedCheckoutPaths.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {workspace.retainedCheckoutPaths.length} shared checkout(s) kept for threads outside
            this Space.
          </p>
        )}
        {workspace.status === "archived" &&
          workspace.retainedCheckoutPaths.length > 0 &&
          !review && (
            <Button
              variant="outline"
              disabled={busy || !canManageCheckouts}
              onClick={() => setReview(true)}
            >
              Review retained checkout cleanup…
            </Button>
          )}
        {workspace.status !== "archived" && workspace.status !== "restoring" && !review && (
          <Button
            variant="ghost-destructive"
            disabled={busy || !canManageCheckouts}
            onClick={() => setReview(true)}
          >
            <ArchiveIcon />
            {workspace.status === "archiving" ? "Review and retry archive" : "Archive Space…"}
          </Button>
        )}
        {review && (
          <div className="space-y-3">
            <h3 className="font-medium">Archive {workspace.name}</h3>
            <p className="text-sm">
              Archive {preview.data?.threadCount ?? "…"}{" "}
              {preview.data?.threadCount === 1 ? "thread" : "threads"} and remove{" "}
              {preview.data?.checkouts.filter((checkout) => !checkout.retained).length ?? "…"}{" "}
              worktree directories. Shared checkouts are kept. Branches and conversation history are
              retained. Running work blocks archive; exclusive checkouts must be clean.
            </p>
            {preview.isPending && (
              <p className="text-xs text-muted-foreground">Checking checkouts…</p>
            )}
            {preview.error && (
              <p role="alert" className="text-sm text-destructive">
                {preview.error}
              </p>
            )}
            {preview.data?.checkouts.map((checkout) => (
              <div key={checkout.path} className="text-xs">
                <strong>
                  {projects.find((project) => project.id === checkout.projectId)?.title ??
                    "Project"}{" "}
                  · {checkout.branch}
                </strong>
                <p className="mt-1 break-all text-muted-foreground">{checkout.path}</p>
                {checkout.retained && (
                  <p className="mt-1 text-muted-foreground">
                    Kept: used by threads outside this Space.
                  </p>
                )}
                {checkout.blockers.map((blocker) => (
                  <p key={blocker.code} className="mt-1 text-destructive">
                    {blocker.message}
                  </p>
                ))}
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="destructive"
                disabled={busy || blocked || preview.isPending || !canManageCheckouts}
                onClick={() => void run({ ...command(), type: "archive" })}
              >
                {busy
                  ? "Archiving…"
                  : workspace.status === "archived"
                    ? "Clean up checkouts"
                    : preview.data?.checkouts.some((checkout) => !checkout.retained)
                      ? "Archive and remove worktrees"
                      : "Archive Space"}
              </Button>
              <Button variant="outline" onClick={preview.refresh} disabled={busy}>
                Recheck
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setReview(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        {!active && (
          <Button
            variant="outline"
            disabled={busy || !canManageCheckouts}
            onClick={() => void run({ ...command(), type: "restore" })}
          >
            {busy
              ? "Restoring…"
              : workspace.status === "archiving"
                ? "Undo partial archive"
                : "Restore Space"}
          </Button>
        )}
      </div>
    </div>
  );
}
