import { useAtomValue } from "@effect/atom-react";
import {
  CommandId,
  type EnvironmentId,
  type NamedWorkspaceSuggestion,
  type ProjectId,
} from "@t3tools/contracts";
import { GitBranchIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { randomUUID } from "../../lib/utils";
import { namedWorkspaces, useWorkspaceScope } from "../../state/namedWorkspaces";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { ComposerBannerStack } from "./ComposerBannerStack";

export function WorkspaceAssociationNotice({
  environmentId,
  projectId,
  draftId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  draftId: DraftId | null;
}) {
  const catalog = useAtomValue(namedWorkspaces.catalogAtom);
  const selectedDraftSpace = useComposerDraftStore((state) =>
    draftId ? state.getDraftSession(draftId)?.spaceId : undefined,
  );
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
  const [, setScope] = useWorkspaceScope();
  const newThread = useNewThreadHandler();
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
  const add = async (value: NamedWorkspaceSuggestion, automatic: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await mutate({
      environmentId,
      input: {
        type: "associate-project",
        commandId: CommandId.make(randomUUID()),
        workspaceId: value.workspaceId,
        projectId,
        branch: value.branch,
        remember: automatic || rememberChoice,
        automatic,
      },
    });
    if (!mounted.current) return;
    setBusy(false);
    if (result._tag === "Failure") {
      setError(formatEnvironmentQueryError(result.cause));
      return;
    }
    const checkout = result.value.checkouts.find(
      (item) => item.projectId === projectId && item.branch === value.branch,
    );
    if (!checkout) return;
    if (draftId) {
      useComposerDraftStore.getState().setDraftThreadContext(draftId, {
        branch: checkout.branch,
        worktreePath: checkout.path,
        envMode: "worktree",
        startFromOrigin: false,
        spaceId: value.workspaceId,
      });
      setScope({ environmentId, workspaceId: value.workspaceId });
    } else if (!automatic) {
      setScope({ environmentId, workspaceId: value.workspaceId });
      await newThread(
        { environmentId, projectId },
        { branch: checkout.branch, worktreePath: checkout.path, envMode: "worktree" },
      );
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
      (draftId !== null &&
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
    void add(suggestion, true);
  }, [
    suggestion,
    candidates,
    canAdd,
    busy,
    query.isPending,
    environmentId,
    projectId,
    add,
    draftId,
    selectedDraftSpace,
  ]);
  if (!suggestion) return null;
  return (
    <ComposerBannerStack
      items={[
        {
          id: "workspace-association",
          variant: error ? "warning" : "info",
          icon: <GitBranchIcon />,
          title: `Add this project to ${suggestion.name}?`,
          description:
            error ??
            `${suggestion.branch} matches. ${suggestion.path ? "Its checkout and threads will join the Space." : "Create a worktree for this existing branch."}`,
          children: (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox
                checked={rememberChoice}
                disabled={busy || !canRemember}
                onCheckedChange={(value) => setRemember(value === true)}
              />
              Remember for this project and Space
            </label>
          ),
          actions: (
            <>
              <Button
                size="compact"
                variant="ghost-muted"
                disabled={busy}
                onClick={async () => {
                  if (rememberChoice) {
                    setBusy(true);
                    const result = await mutate({
                      environmentId,
                      input: {
                        type: "set-project-association",
                        commandId: CommandId.make(randomUUID()),
                        workspaceId: suggestion.workspaceId,
                        projectId,
                        choice: "separate",
                      },
                    });
                    if (!mounted.current) return;
                    setBusy(false);
                    if (result._tag === "Failure") {
                      setError(formatEnvironmentQueryError(result.cause));
                      return;
                    }
                  }
                  setDismissed((current) => [...current, suggestion.workspaceId]);
                }}
              >
                Keep separate
              </Button>
              <Button
                size="compact"
                disabled={busy || !canAdd}
                onClick={() => void add(suggestion, false)}
              >
                {busy ? "Adding…" : "Add to Space"}
              </Button>
            </>
          ),
        },
      ]}
    />
  );
}
