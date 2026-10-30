import type { NamedWorkspace, NamedWorkspaceId } from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "./path.ts";

export function resolveThreadSpaceId(
  thread: {
    readonly spaceId?: NamedWorkspaceId | null | undefined;
    readonly worktreePath: string | null;
  },
  spaces: readonly NamedWorkspace[],
): NamedWorkspaceId | null {
  if (thread.spaceId !== undefined) return thread.spaceId;
  const checkoutPath = thread.worktreePath;
  if (checkoutPath === null) return null;
  return (
    spaces.find((space) =>
      space.checkouts.some(
        (checkout) =>
          normalizeProjectPathForComparison(checkout.path) ===
          normalizeProjectPathForComparison(checkoutPath),
      ),
    )?.id ?? null
  );
}
