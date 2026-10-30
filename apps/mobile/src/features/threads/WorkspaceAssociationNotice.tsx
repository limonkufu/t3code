import { useAtomValue } from "@effect/atom-react";
import { CommandId, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { uuidv4 } from "../../lib/uuid";
import { namedWorkspaces, useNamedWorkspaceScope } from "../../state/namedWorkspaces";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { updateComposerDraftSettings, useComposerDraft } from "../../state/use-composer-drafts";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";

export function WorkspaceAssociationNotice({
  environmentId,
  projectId,
  draftKey,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  draftKey: string | null;
}) {
  const catalog = useAtomValue(namedWorkspaces.catalogAtom);
  const selectedDraftSpace = useComposerDraft(draftKey ?? "").spaceId;
  const ready = useAtomValue(namedWorkspaces.readyEnvironmentIdsAtom).has(environmentId);
  const query = useEnvironmentQuery(
    ready &&
      catalog.some(
        (entry) => entry.environmentId === environmentId && entry.workspace.status === "active",
      )
      ? namedWorkspaces.suggestions({ environmentId, input: { projectId } })
      : null,
  );
  const mutate = useAtomCommand(namedWorkspaces.mutate, { reportFailure: false });
  const [, setScope] = useNamedWorkspaceScope();
  const selectDetail = useSelectWorkspaceDetail();
  const [remember, setRemember] = useState(true);
  const canRemember = useAtomValue(namedWorkspaces.mutate.permissionAtom(environmentId));
  const rememberChoice = remember && canRemember;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<readonly string[]>([]);
  const attempted = useRef(new Set<string>());
  const mounted = useRef(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asynchronous checkout completion must not navigate away from a different composer
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const candidates = (query.data ?? []).flatMap((suggestion) => {
    const workspace = catalog.find(
      (entry) =>
        entry.environmentId === environmentId && entry.workspace.id === suggestion.workspaceId,
    )?.workspace;
    const choice =
      workspace?.associationChoices.find((item) => item.projectId === projectId)?.choice ?? null;
    return workspace?.status === "active" &&
      !workspace.checkouts.some((checkout) => checkout.projectId === projectId) &&
      choice !== "separate" &&
      !dismissed.includes(suggestion.workspaceId)
      ? [{ ...suggestion, choice, name: workspace.name }]
      : [];
  });
  const suggestion = candidates[0];
  const permissionInput = suggestion
    ? {
        type: "associate-project" as const,
        commandId: CommandId.make("permission"),
        workspaceId: suggestion.workspaceId,
        projectId,
        branch: suggestion.branch,
        remember: rememberChoice,
      }
    : undefined;
  const canAdd = useAtomValue(
    namedWorkspaces.mutate.permissionAtom(environmentId, permissionInput),
  );
  const showFailure = (cause: Cause.Cause<unknown>) => {
    const failure = Cause.squash(cause);
    setError(failure instanceof Error ? failure.message : "The project could not be added.");
  };
  const add = async (automatic: boolean) => {
    if (!suggestion || busy) return;
    setBusy(true);
    setError(null);
    const result = await mutate({
      environmentId,
      input: {
        type: "associate-project",
        commandId: CommandId.make(uuidv4()),
        workspaceId: suggestion.workspaceId,
        projectId,
        branch: suggestion.branch,
        remember: automatic || rememberChoice,
        automatic,
      },
    });
    if (!mounted.current) return;
    setBusy(false);
    if (result._tag === "Failure") {
      showFailure(result.cause);
      return;
    }
    const checkout = result.value.checkouts.find(
      (item) => item.projectId === projectId && item.branch === suggestion.branch,
    );
    if (!checkout) return;
    if (draftKey) {
      updateComposerDraftSettings(draftKey, {
        spaceId: suggestion.workspaceId,
        workspaceSelection: {
          mode: "local",
          branch: checkout.branch,
          worktreePath: checkout.path,
          startFromOrigin: false,
        },
      });
      setScope({ environmentId, workspaceId: suggestion.workspaceId });
    } else if (!automatic) {
      setScope({ environmentId, workspaceId: suggestion.workspaceId });
      selectDetail({
        name: "Thread",
        params: {
          draft: {
            requestId: uuidv4(),
            environmentId: String(environmentId),
            projectId: String(projectId),
            branch: checkout.branch,
            worktreePath: checkout.path,
          },
        },
      });
    }
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- applies a server-saved association choice when a project is opened, once per candidate
  useEffect(() => {
    if (
      !suggestion ||
      !canAdd ||
      busy ||
      query.isPending ||
      suggestion.choice !== "add" ||
      (draftKey !== null &&
        selectedDraftSpace !== undefined &&
        selectedDraftSpace !== suggestion.workspaceId) ||
      candidates.filter((item) => item.workspaceId === suggestion.workspaceId).length !== 1
    )
      return;
    const key = JSON.stringify([
      environmentId,
      projectId,
      suggestion.workspaceId,
      suggestion.branch,
    ]);
    if (attempted.current.has(key)) return;
    attempted.current.add(key);
    void add(true);
  }, [
    suggestion,
    candidates,
    canAdd,
    busy,
    query.isPending,
    environmentId,
    projectId,
    add,
    draftKey,
    selectedDraftSpace,
  ]);
  if (!suggestion) return null;
  return (
    <View className="mb-2 gap-2 rounded-xl border border-border bg-subtle p-3">
      <Text className="font-t3-medium text-foreground">Add this project to {suggestion.name}?</Text>
      <Text className="text-xs text-foreground-muted">
        {suggestion.branch} matches.{" "}
        {suggestion.path
          ? "Its checkout and threads will join the Space."
          : "Create a worktree for this existing branch."}
      </Text>
      {error && (
        <Text accessibilityRole="alert" className="text-danger">
          {error}
        </Text>
      )}
      <ListToggleRow
        label="Remember for this project and Space"
        value={rememberChoice}
        onValueChange={setRemember}
        disabled={busy || !canRemember}
      />
      <View className="flex-row flex-wrap gap-2">
        <Button
          label="Keep separate"
          tone="text"
          disabled={busy}
          onPress={async () => {
            if (rememberChoice) {
              setBusy(true);
              const result = await mutate({
                environmentId,
                input: {
                  type: "set-project-association",
                  commandId: CommandId.make(uuidv4()),
                  workspaceId: suggestion.workspaceId,
                  projectId,
                  choice: "separate",
                },
              });
              if (!mounted.current) return;
              setBusy(false);
              if (result._tag === "Failure") {
                showFailure(result.cause);
                return;
              }
            }
            setDismissed((current) => [...current, suggestion.workspaceId]);
          }}
        />
        <Button
          label={busy ? "Adding…" : "Add to Space"}
          disabled={busy || !canAdd}
          onPress={() => void add(false)}
        />
      </View>
    </View>
  );
}
