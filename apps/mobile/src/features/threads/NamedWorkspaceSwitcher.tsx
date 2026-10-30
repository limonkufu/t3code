import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import { useAtomValue } from "@effect/atom-react";
import {
  workspaceScopeKey,
  type ScopedNamedWorkspace,
} from "@t3tools/client-runtime/state/namedWorkspaces";
import { CommandId, NamedWorkspaceId, type NamedWorkspaceMutation } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { SelectionRow } from "../../components/ui/SelectionRow";
import { Sheet } from "../../components/ui/Sheet";
import { uuidv4 } from "../../lib/uuid";
import { useProjects } from "../../state/entities";
import {
  namedWorkspaces,
  useNamedWorkspaceScope,
  useIncludeWorkspaceThreads,
  readNamedWorkspaceView,
} from "../../state/namedWorkspaces";
import { environmentPresentations } from "../../state/presentation";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import { useWorkspaceEnvironments } from "../../state/workspace";

export function NamedWorkspaceSwitcher() {
  const entries = useAtomValue(namedWorkspaces.catalogAtom);
  const selectDetail = useSelectWorkspaceDetail();
  const restoreView = (scope: Parameters<typeof readNamedWorkspaceView>[0]) => {
    const previous = readNamedWorkspaceView(scope).lastThread;
    if (previous) selectDetail({ name: "Thread", params: previous });
  };
  const [scope, setScope] = useNamedWorkspaceScope();
  const [includeOwned, setIncludeOwned] = useIncludeWorkspaceThreads();
  const configs = useAtomValue(environmentPresentations.serverConfigsAtom);
  const hosts = useWorkspaceEnvironments().filter(
    (host) =>
      host.connectionState === "connected" && configs.get(host.environmentId)?.namedWorkspaces,
  );
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [hostId, setHostId] = useState(hosts[0]?.environmentId ?? null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const mutate = useAtomCommand(namedWorkspaces.mutate);
  const effectiveHost = hostId ?? hosts[0]?.environmentId ?? null;
  const canCreate = useAtomValue(namedWorkspaces.mutate.permissionAtom(effectiveHost));
  const selected = entries.find(
    (entry) =>
      scope?.environmentId === entry.environmentId && scope.workspaceId === entry.workspace.id,
  );
  const edited = entries.find(
    (entry) =>
      workspaceScopeKey({ environmentId: entry.environmentId, workspaceId: entry.workspace.id }) ===
      editing,
  );
  if (hosts.length === 0 && entries.length === 0) return null;
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Choose Space"
        onPress={() => {
          setEditing(null);
          setOpen(true);
        }}
        className="mx-3 my-2 min-h-11 flex-row items-center justify-between rounded-lg bg-subtle px-3"
      >
        <Text className="shrink font-t3-medium text-foreground">
          {selected?.workspace.name ?? "All threads"}
        </Text>
        <Text className="text-xs text-foreground-muted">Spaces ›</Text>
      </Pressable>
      {open && (
        <Sheet title="Spaces" onClose={() => setOpen(false)}>
          {edited ? (
            <NativeWorkspaceEditor
              onClose={() => setOpen(false)}
              key={editing}
              entry={edited}
              onBack={() => setEditing(null)}
            />
          ) : (
            <ScrollView
              contentInsetAdjustmentBehavior="automatic"
              keyboardShouldPersistTaps="handled"
            >
              <View className="gap-4 px-4 pb-8 pt-4">
                <SelectionRow
                  title="All threads"
                  selected={scope === null}
                  onPress={() => {
                    setScope(null);
                    restoreView(null);
                    setOpen(false);
                  }}
                />
                {entries.map((entry) => {
                  const ref = {
                    environmentId: entry.environmentId,
                    workspaceId: entry.workspace.id,
                  };
                  return (
                    <View key={workspaceScopeKey(ref)} className="gap-1">
                      <SelectionRow
                        title={entry.workspace.name}
                        subtitle={`${entry.workspace.checkouts.length} checkouts · ${entry.workspace.status}`}
                        selected={
                          scope !== null && workspaceScopeKey(scope) === workspaceScopeKey(ref)
                        }
                        onPress={() => {
                          setScope(ref);
                          restoreView(ref);
                          setOpen(false);
                        }}
                      />
                      <Button
                        label={`Manage ${entry.workspace.name}`}
                        tone="text"
                        onPress={() => setEditing(workspaceScopeKey(ref))}
                      />
                    </View>
                  );
                })}
                <ListToggleRow
                  label="Space threads in All threads"
                  description="Notifications stay enabled."
                  value={includeOwned}
                  onValueChange={setIncludeOwned}
                />
                <Text className="font-t3-medium text-foreground">Create Space</Text>
                {hosts.length > 1 &&
                  hosts.map((host) => (
                    <SelectionRow
                      key={host.environmentId}
                      title={configs.get(host.environmentId)?.environment.label ?? "Environment"}
                      selected={effectiveHost === host.environmentId}
                      onPress={() => setHostId(host.environmentId)}
                    />
                  ))}
                <WorkspaceInput label="Space name" value={name} onChangeText={setName} />
                <Button
                  label="Create Space"
                  disabled={busy || !canCreate || !name.trim() || !effectiveHost}
                  onPress={() => {
                    if (!effectiveHost) return;
                    setBusy(true);
                    const workspaceId = NamedWorkspaceId.make(uuidv4());
                    void mutate({
                      environmentId: effectiveHost,
                      input: {
                        type: "create",
                        commandId: CommandId.make(uuidv4()),
                        workspaceId,
                        name: name.trim(),
                      },
                    }).then((result) => {
                      setBusy(false);
                      if (result._tag === "Success") {
                        setName("");
                        setEditing(
                          workspaceScopeKey({ environmentId: effectiveHost, workspaceId }),
                        );
                      }
                    });
                  }}
                />
              </View>
            </ScrollView>
          )}
        </Sheet>
      )}
    </>
  );
}

function WorkspaceInput({
  label,
  value,
  onChangeText,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
}) {
  return (
    <View className="gap-1">
      <Text className="text-xs text-foreground-muted">{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        autoCapitalize="none"
        autoCorrect={false}
        className="min-h-12 rounded-lg border border-border px-3 text-foreground"
      />
    </View>
  );
}

function NativeWorkspaceEditor({
  entry,
  onBack,
  onClose,
}: {
  entry: ScopedNamedWorkspace;
  onBack: () => void;
  onClose: () => void;
}) {
  const selectDetail = useSelectWorkspaceDetail();
  const { workspace, environmentId } = entry;
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [projectId, setProjectId] = useState(projects[0]?.id ?? null);
  const [name, setName] = useState(workspace.name);
  const [path, setPath] = useState("");
  const [branch, setBranch] = useState("");
  const [baseRef, setBaseRef] = useState("HEAD");
  const [createNew, setCreateNew] = useState(false);
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, setScope] = useNamedWorkspaceScope();
  const mutate = useAtomCommand(namedWorkspaces.mutate);
  const createWorktree = useAtomCommand(vcsEnvironment.createWorktree);
  const canEdit = useAtomValue(namedWorkspaces.mutate.permissionAtom(environmentId));
  const canManage = useAtomValue(
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
  const command = () => ({ commandId: CommandId.make(uuidv4()), workspaceId: workspace.id });
  const active = workspace.status === "active";
  const canReleaseCheckout =
    active || workspace.status === "archived" || workspace.lastError !== null;
  const run = async (input: NamedWorkspaceMutation) => {
    setBusy(true);
    setError(null);
    const result = await mutate({ environmentId, input });
    setBusy(false);
    if (result._tag === "Failure") {
      const cause = Cause.squash(result.cause);
      setError(cause instanceof Error ? cause.message : "The workspace operation failed.");
      return false;
    }
    if (input.type === "archive") {
      setScope(null);
      setReview(false);
    }
    return true;
  };
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled">
      <View className="gap-4 px-4 pb-8 pt-4">
        {!review && (
          <>
            <Button label="All Spaces" tone="text" onPress={onBack} />
            <WorkspaceInput label="Space name" value={name} onChangeText={setName} />
            <Button
              label="Save name"
              disabled={busy || !canEdit || !name.trim() || name === workspace.name}
              onPress={() => void run({ ...command(), type: "rename", name: name.trim() })}
            />
            <Text className="font-t3-medium text-foreground">Checkouts · {workspace.status}</Text>
            {workspace.checkouts.map((checkout) => (
              <View key={checkout.path} className="gap-2 border-b border-border pb-3">
                <Text className="font-t3-medium text-foreground">{checkout.branch}</Text>
                <Text className="text-xs text-foreground-muted">{checkout.path}</Text>
                <Button
                  label="New thread here"
                  disabled={busy || !active || !canEdit}
                  onPress={() => {
                    setScope({ environmentId, workspaceId: workspace.id });
                    onClose();
                    selectDetail({
                      name: "Thread",
                      params: {
                        draft: {
                          requestId: uuidv4(),
                          environmentId: String(environmentId),
                          projectId: String(checkout.projectId),
                          branch: checkout.branch,
                          worktreePath: checkout.path,
                        },
                      },
                    });
                  }}
                />

                {canReleaseCheckout && (
                  <Button
                    label="Remove from workspace"
                    tone="text"
                    disabled={busy || !canEdit}
                    onPress={() => void run({ ...command(), type: "detach", path: checkout.path })}
                  />
                )}
              </View>
            ))}
            {active && (
              <View className="gap-3">
                <ListToggleRow
                  label="Create a new worktree"
                  value={createNew}
                  onValueChange={setCreateNew}
                />
                {projects.map((project) => (
                  <SelectionRow
                    key={project.id}
                    title={project.title}
                    selected={projectId === project.id}
                    onPress={() => setProjectId(project.id)}
                  />
                ))}
                {createNew ? (
                  <>
                    <WorkspaceInput label="New branch" value={branch} onChangeText={setBranch} />
                    <WorkspaceInput label="Base branch" value={baseRef} onChangeText={setBaseRef} />
                  </>
                ) : (
                  <WorkspaceInput
                    label="Existing worktree path"
                    value={path}
                    onChangeText={setPath}
                  />
                )}
                <Text className="text-xs text-foreground-muted">
                  All threads in this checkout join the Space. Archiving removes its directory.
                  Project roots stay protected.
                </Text>
                <Button
                  label={createNew ? "Create and add worktree" : "Add worktree"}
                  disabled={
                    busy || !canManage || !projectId || !(createNew ? branch.trim() : path.trim())
                  }
                  onPress={() => {
                    const project = projects.find((candidate) => candidate.id === projectId);
                    if (!project) return;
                    const attach = (checkoutPath: string) =>
                      run({
                        ...command(),
                        type: "attach",
                        projectId: project.id,
                        path: checkoutPath,
                      }).then((success) => {
                        if (success) {
                          setPath("");
                          setBranch("");
                        }
                      });
                    if (!createNew) {
                      void attach(path.trim());
                      return;
                    }
                    setBusy(true);
                    void createWorktree({
                      environmentId,
                      input: {
                        cwd: project.workspaceRoot,
                        refName: baseRef.trim() || "HEAD",
                        newRefName: branch.trim(),
                        path: null,
                      },
                    }).then((result) => {
                      setBusy(false);
                      if (result._tag === "Success") {
                        setPath(result.value.worktree.path);
                        setCreateNew(false);
                        void attach(result.value.worktree.path);
                      }
                    });
                  }}
                />
              </View>
            )}
          </>
        )}
        {workspace.associationChoices.length > 0 && (
          <View className="gap-2">
            <Text className="text-xs text-foreground-muted">Remembered project choices</Text>
            {workspace.associationChoices.map((item) => (
              <View key={item.projectId} className="gap-1">
                <Text className="text-foreground">
                  {projects.find((project) => project.id === item.projectId)?.title ??
                    item.projectId}{" "}
                  · {item.choice === "add" ? "Add matching branches" : "Keep separate"}
                </Text>
                <Button
                  label="Ask next time"
                  tone="text"
                  disabled={busy || !canEdit}
                  onPress={() =>
                    void run({
                      ...command(),
                      type: "set-project-association",
                      projectId: item.projectId,
                      choice: null,
                    })
                  }
                />
              </View>
            ))}
          </View>
        )}
        {(workspace.lastError || error) && (
          <Text accessibilityRole="alert" className="text-danger">
            {workspace.lastError ?? error}
          </Text>
        )}
        {workspace.status !== "archived" && workspace.status !== "restoring" && !review && (
          <Button
            label={active ? "Archive Space…" : "Review and retry archive"}
            tone="danger"
            disabled={busy || !canManage}
            onPress={() => setReview(true)}
          />
        )}
        {review && (
          <View className="gap-3">
            <Text className="font-t3-medium text-foreground">Archive {workspace.name}</Text>
            <Text className="text-foreground">
              Archive {preview.data?.threadCount ?? "…"} threads and remove{" "}
              {workspace.checkouts.length} worktree directories. Branches and history are retained.
              Unsaved files and running work block archive.
            </Text>
            {preview.error && <Text className="text-danger">{preview.error}</Text>}
            {preview.data?.checkouts.map((checkout) => (
              <View key={checkout.path}>
                <Text className="font-t3-medium text-foreground">
                  {projects.find((project) => project.id === checkout.projectId)?.title ??
                    "Project"}{" "}
                  · {checkout.branch}
                </Text>
                <Text className="text-xs text-foreground-muted">{checkout.path}</Text>
                {checkout.blockers.map((blocker) => (
                  <Text key={blocker.code} className="text-danger">
                    {blocker.message}
                  </Text>
                ))}
              </View>
            ))}
            <Button
              label={busy ? "Archiving…" : "Archive and remove worktrees"}
              tone="danger"
              disabled={
                busy ||
                !canManage ||
                !preview.data ||
                preview.isPending ||
                preview.data.checkouts.some((checkout) => checkout.blockers.length > 0)
              }
              onPress={() => void run({ ...command(), type: "archive" })}
            />
            <Button label="Recheck" onPress={preview.refresh} disabled={busy} />
            <Button label="Cancel" tone="text" onPress={() => setReview(false)} disabled={busy} />
          </View>
        )}
        {!active && (
          <Button
            label={workspace.status === "archiving" ? "Undo partial archive" : "Restore Space"}
            disabled={busy || !canManage}
            onPress={() => void run({ ...command(), type: "restore" })}
          />
        )}
      </View>
    </ScrollView>
  );
}
