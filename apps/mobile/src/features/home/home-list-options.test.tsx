import type { EnvironmentId } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({ saved: [] as unknown[], scoped: false }));

vi.mock("../../state/namedWorkspaces", async () => {
  const { useState } = await import("react");
  return {
    useNamedWorkspaceScope: () => [
      harness.scoped ? { environmentId: "env-1", workspaceId: "workspace" } : null,
      () => {},
    ],
    useNamedWorkspaceView: () => {
      const [view, setView] = useState<
        import("../../persistence/mobile-preferences").NamedWorkspaceView
      >({});
      return [
        view,
        (patch: Partial<typeof view> | ((current: typeof view) => Partial<typeof view>)) =>
          setView((current) => {
            const next = { ...current, ...(typeof patch === "function" ? patch(current) : patch) };
            harness.saved.push({ namedWorkspaceView: next });
            return next;
          }),
      ];
    },
  };
});
vi.mock("../../state/preferences", () => ({ updateMobilePreferencesAtom: {} }));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomSet: () => (value: unknown) => harness.saved.push(value),
}));

import { HomeListOptionsProvider, useHomeListOptions } from "./home-list-options";

const ENVIRONMENT = "env-1" as EnvironmentId;
const AVAILABLE = new Set([ENVIRONMENT]);

it.each([false, true])(
  "saves the scope from every update made in one event (workspace: %s)",
  async (scoped) => {
    harness.saved = [];
    harness.scoped = scoped;
    let controls: ReturnType<typeof useHomeListOptions> | undefined;
    function Probe() {
      const result = useHomeListOptions(AVAILABLE);
      useLayoutEffect(() => {
        controls = result;
      });
      return null;
    }

    const root = createRoot(document.createElement("div"));
    await act(async () =>
      root.render(
        <HomeListOptionsProvider projectGroupingMode="repository">
          <Probe />
        </HomeListOptionsProvider>,
      ),
    );
    act(() => {
      controls!.setSelectedEnvironmentId(ENVIRONMENT);
      controls!.setSelectedProjectKey("env-1:project-1");
    });

    expect(harness.saved.at(-1)).toEqual(
      scoped
        ? {
            namedWorkspaceView: {
              filters: { environmentId: ENVIRONMENT, projectKey: "env-1:project-1" },
            },
          }
        : {
            threadListFilters: { environmentId: ENVIRONMENT, projectKey: "env-1:project-1" },
          },
    );
    expect(controls!.options.selectedEnvironmentId).toBe(ENVIRONMENT);
    expect(controls!.options.selectedProjectKey).toBe("env-1:project-1");
    act(() => root.unmount());
  },
);
