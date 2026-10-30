import { useNamedWorkspaceScope, useNamedWorkspaceView } from "../../state/namedWorkspaces";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

export function useThreadListV2ShelfPreferences() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  const [scope] = useNamedWorkspaceScope();
  const [view, updateView] = useNamedWorkspaceView();
  const snoozedShelfExpanded = scope
    ? view.snoozedExpanded === true
    : loaded && preferencesResult.value.threadListSnoozedShelfExpanded === true;
  const settledShelfExpanded = scope
    ? view.settledExpanded === true
    : loaded && preferencesResult.value.threadListSettledShelfExpanded === true;
  const workingShelfEnabled = loaded && preferencesResult.value.workingShelfEnabled !== false;
  const workingShelfExpanded = scope
    ? view.workingExpanded === true
    : loaded && preferencesResult.value.threadListWorkingShelfExpanded === true;

  // Transforms read optimistic state so same-frame presses toggle twice.
  const toggleSnoozedShelf = () => {
    if (!loaded) return;
    if (scope) {
      updateView({ snoozedExpanded: !snoozedShelfExpanded });
      return;
    }
    savePreferences({
      transform: (current) => ({
        threadListSnoozedShelfExpanded: current.threadListSnoozedShelfExpanded !== true,
      }),
    });
  };
  const toggleSettledShelf = () => {
    if (!loaded) return;
    if (scope) {
      updateView({ settledExpanded: !settledShelfExpanded });
      return;
    }
    savePreferences({
      transform: (current) => ({
        threadListSettledShelfExpanded: current.threadListSettledShelfExpanded !== true,
      }),
    });
  };
  const toggleWorkingShelf = () => {
    if (!loaded) return;
    if (scope) {
      updateView({ workingExpanded: !workingShelfExpanded });
      return;
    }
    savePreferences({
      transform: (current) => ({
        threadListWorkingShelfExpanded: current.threadListWorkingShelfExpanded !== true,
      }),
    });
  };

  return {
    loaded,
    settledShelfExpanded,
    snoozedShelfExpanded,
    workingShelfEnabled,
    workingShelfExpanded,
    toggleSettledShelf,
    toggleSnoozedShelf,
    toggleWorkingShelf,
  } as const;
}
