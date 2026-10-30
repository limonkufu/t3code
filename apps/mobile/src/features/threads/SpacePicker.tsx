import { useThreadShells } from "../../state/entities";
import { useAtomValue } from "@effect/atom-react";
import {
  CommandId,
  NamedWorkspaceId,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { resolveThreadSpaceId } from "@t3tools/shared/threadSpace";
import * as Cause from "effect/Cause";
import { useState } from "react";
import { ScrollView, TextInput, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SelectionRow } from "../../components/ui/SelectionRow";
import { Sheet } from "../../components/ui/Sheet";
import { uuidv4 } from "../../lib/uuid";
import { namedWorkspaces, useNamedWorkspaceScope } from "../../state/namedWorkspaces";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useComposerDraft, updateComposerDraftSettings } from "../../state/use-composer-drafts";

export function DraftSpacePicker({
  environmentId,
  draftKey,
}: {
  environmentId: EnvironmentId;
  draftKey: string;
}) {
  const draft = useComposerDraft(draftKey);
  const spaces = useAtomValue(namedWorkspaces.catalogAtom)
    .filter((entry) => entry.environmentId === environmentId)
    .map((entry) => entry.workspace);
  const [scope] = useNamedWorkspaceScope();
  const [open, setOpen] = useState(false);
  const spaceId =
    draft.spaceId !== undefined
      ? draft.spaceId
      : scope?.environmentId === environmentId
        ? scope.workspaceId
        : null;
  return (
    <View className="mb-2">
      <Button
        tone="text"
        label={`Space: ${spaces.find((space) => space.id === spaceId)?.name ?? "No Space"}`}
        onPress={() => setOpen(true)}
      />
      {open && (
        <SpaceAssignmentSheet
          environmentId={environmentId}
          draftKey={draftKey}
          onClose={() => setOpen(false)}
        />
      )}
    </View>
  );
}

export function SpaceAssignmentSheet({
  environmentId,
  threadRef,
  draftKey,
  onClose,
}: {
  environmentId: EnvironmentId;
  threadRef?: ScopedThreadRef;
  draftKey?: string;
  onClose: () => void;
}) {
  const draft = useComposerDraft(draftKey ?? "");
  const shell = useThreadShells().find(
    (item) => item.environmentId === environmentId && item.id === threadRef?.threadId,
  );
  const entries = useAtomValue(namedWorkspaces.catalogAtom);
  const spaces = entries
    .filter((entry) => entry.environmentId === environmentId)
    .map((entry) => entry.workspace);
  const [scope, setScope] = useNamedWorkspaceScope();
  const selectedId = draftKey
    ? draft.spaceId !== undefined
      ? draft.spaceId
      : scope?.environmentId === environmentId
        ? scope.workspaceId
        : null
    : shell
      ? resolveThreadSpaceId(shell, spaces)
      : null;
  const mutate = useAtomCommand(namedWorkspaces.mutate, { reportFailure: false });
  const move = useAtomCommand(threadEnvironment.updateMetadata, { reportFailure: false });
  const canEdit = useAtomValue(namedWorkspaces.mutate.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fail = (cause: Cause.Cause<unknown>) => {
    const value = Cause.squash(cause);
    setError(value instanceof Error ? value.message : "The Space could not be changed.");
  };
  const assign = async (spaceId: NamedWorkspaceId | null) => {
    if (busy) return;
    setBusy(true);
    if (draftKey) updateComposerDraftSettings(draftKey, { spaceId });
    else if (threadRef) {
      const result = await move({
        environmentId,
        input: { threadId: threadRef.threadId, spaceId },
      });
      if (result._tag === "Failure") {
        fail(result.cause);
        setBusy(false);
        return;
      }
    }
    setScope(spaceId === null ? null : { environmentId, workspaceId: spaceId });
    onClose();
  };
  return (
    <Sheet title={draftKey ? "Choose Space" : "Move thread to Space"} onClose={onClose}>
      <ScrollView keyboardShouldPersistTaps="handled">
        <View className="gap-3 px-4 pb-8 pt-4">
          <Text className="text-sm text-foreground-muted">
            Group threads across projects using their current checkout.
          </Text>
          <SelectionRow
            title="No Space"
            selected={selectedId === null}
            disabled={busy || (!draftKey && !canEdit)}
            onPress={() => void assign(null)}
          />
          {spaces.map((space) => (
            <SelectionRow
              key={space.id}
              title={space.name}
              {...(space.status === "active" ? {} : { subtitle: space.status })}
              selected={selectedId === space.id}
              disabled={busy || space.status !== "active" || (!draftKey && !canEdit)}
              onPress={() => void assign(space.id)}
            />
          ))}
          <TextInput
            accessibilityLabel="New Space name"
            placeholder="New Space name"
            value={name}
            maxLength={80}
            onChangeText={setName}
            className="min-h-12 rounded-lg border border-border px-3 text-foreground"
          />
          <Button
            label="Create Space"
            disabled={busy || !canEdit || !name.trim()}
            onPress={async () => {
              setBusy(true);
              const workspaceId = NamedWorkspaceId.make(uuidv4());
              const result = await mutate({
                environmentId,
                input: {
                  type: "create",
                  workspaceId,
                  commandId: CommandId.make(uuidv4()),
                  name: name.trim(),
                },
              });
              setBusy(false);
              if (result._tag === "Failure") fail(result.cause);
              else void assign(workspaceId);
            }}
          />
          {error && (
            <Text accessibilityRole="alert" className="text-danger">
              {error}
            </Text>
          )}
        </View>
      </ScrollView>
    </Sheet>
  );
}
