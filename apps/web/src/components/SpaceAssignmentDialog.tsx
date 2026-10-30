import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { CommandId, NamedWorkspaceId } from "@t3tools/contracts";
import { resolveThreadSpaceId } from "@t3tools/shared/threadSpace";
import { CheckIcon, LayersIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { useQuietThreadShell } from "../state/entities";
import {
  namedWorkspaces,
  spaceAssignmentTargetAtom,
  useWorkspaceScope,
  type SpaceAssignmentTarget,
} from "../state/namedWorkspaces";
import { formatEnvironmentQueryError } from "../state/query";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { randomUUID } from "../lib/utils";
import { Button } from "./ui/button";
import { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogPopup } from "./ui/dialog";
import { Input } from "./ui/input";

export function DraftSpacePicker({ draftId }: { draftId: DraftId }) {
  const target = useComposerDraftStore((state) => state.getDraftSession(draftId));
  const entries = useAtomValue(namedWorkspaces.catalogAtom);
  const open = useAtomSet(spaceAssignmentTargetAtom);
  if (!target) return null;
  const spaces = entries
    .filter((entry) => entry.environmentId === target.environmentId)
    .map((entry) => entry.workspace);
  const id = resolveThreadSpaceId(target, spaces);
  return (
    <div className="mb-2 flex items-center px-3">
      <Button
        variant="ghost-muted"
        size="compact"
        aria-label="Choose Space"
        onClick={() => open({ environmentId: target.environmentId, draftId })}
      >
        <LayersIcon />
        <span>{spaces.find((space) => space.id === id)?.name ?? "No Space"}</span>
      </Button>
    </div>
  );
}

export function SpaceAssignmentDialog() {
  const [target, setTarget] = useAtom(spaceAssignmentTargetAtom);
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) setTarget(null);
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {target && "draftId" in target ? "Choose Space" : "Move thread to Space"}
          </DialogTitle>
          <DialogDescription>
            Keep related threads together across projects. Your current checkout is preserved.
          </DialogDescription>
        </DialogHeader>
        {target && (
          <SpaceDestination
            key={JSON.stringify(target)}
            target={target}
            onDone={() => setTarget(null)}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

function SpaceDestination({
  target,
  onDone,
}: {
  target: SpaceAssignmentTarget;
  onDone: () => void;
}) {
  const entries = useAtomValue(namedWorkspaces.catalogAtom);
  const spaces = entries
    .filter((entry) => entry.environmentId === target.environmentId)
    .map((entry) => entry.workspace);
  const draft = useComposerDraftStore((state) =>
    "draftId" in target ? state.getDraftSession(target.draftId) : null,
  );
  const thread = useQuietThreadShell("threadId" in target ? target : null);
  const selected = (draft ?? thread) ? resolveThreadSpaceId((draft ?? thread)!, spaces) : null;
  const mutate = useAtomCommand(namedWorkspaces.mutate, { reportFailure: false });
  const move = useOrchestrationCommand(threadEnvironment.updateMetadata, { reportFailure: false });
  const canEdit = useAtomValue(namedWorkspaces.mutate.permissionAtom(target.environmentId));
  const [, setScope] = useWorkspaceScope();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const assign = async (spaceId: NamedWorkspaceId | null) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    if ("draftId" in target)
      useComposerDraftStore.getState().setDraftThreadContext(target.draftId, { spaceId });
    else {
      const result = await move({
        environmentId: target.environmentId,
        input: { threadId: target.threadId, spaceId },
      });
      if (result._tag === "Failure") {
        setError(formatEnvironmentQueryError(result.cause));
        setBusy(false);
        return;
      }
    }
    setScope(
      spaceId === null ? null : { environmentId: target.environmentId, workspaceId: spaceId },
    );
    onDone();
  };
  return (
    <div className="space-y-4 px-6 pb-6">
      <div className="max-h-64 space-y-1 overflow-y-auto">
        {[{ id: null, name: "No Space", status: "active" }, ...spaces].map((space) => (
          <button
            type="button"
            key={space.id ?? "none"}
            aria-pressed={space.id === selected}
            disabled={busy || space.status !== "active" || (!("draftId" in target) && !canEdit)}
            onClick={() => void assign(space.id)}
            className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
          >
            <LayersIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{space.name}</span>
            {space.id === selected && <CheckIcon className="size-4" />}
            {space.status !== "active" && (
              <span className="text-xs text-muted-foreground">{space.status}</span>
            )}
          </button>
        ))}
      </div>
      <form
        className="flex gap-2 border-t pt-4"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!name.trim() || busy) return;
          setBusy(true);
          const workspaceId = NamedWorkspaceId.make(randomUUID());
          const result = await mutate({
            environmentId: target.environmentId,
            input: {
              type: "create",
              commandId: CommandId.make(randomUUID()),
              workspaceId,
              name: name.trim(),
            },
          });
          setBusy(false);
          if (result._tag === "Failure") setError(formatEnvironmentQueryError(result.cause));
          else void assign(workspaceId);
        }}
      >
        <div className="min-w-0 flex-1">
          <Input
            aria-label="New Space name"
            placeholder="New Space name"
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <Button type="submit" variant="outline" disabled={!canEdit || busy || !name.trim()}>
          <PlusIcon />
          Create
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
