import { useEffect, useRef } from "react";

import type { WorkspaceSearchMode } from "./workspace-tabs-state";

export function useSearchScrollRestoration(
  searchMode: WorkspaceSearchMode | undefined,
  restore: () => void,
  scopeKey?: string,
) {
  const previousSearchMode = useRef(searchMode);
  const previousScope = useRef(scopeKey);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- restores the native list's saved search or Space position
  useEffect(() => {
    const cancelledSearch =
      previousSearchMode.current !== undefined &&
      previousSearchMode.current !== "resting" &&
      searchMode === "resting";
    const scopeChanged = previousScope.current !== scopeKey;
    previousSearchMode.current = searchMode;
    previousScope.current = scopeKey;
    if (cancelledSearch || (scopeChanged && (searchMode === undefined || searchMode === "resting")))
      restore();
  }, [searchMode, restore, scopeKey]);
}
