import { describe, expect, it } from "vite-plus/test";

import * as ThreadUndo from "@t3tools/client-runtime/state/thread-undo";

describe("thread action ownership", () => {
  it("does not revive the first Undo after a later pin and unpin", () => {
    const firstUnpin = ThreadUndo.begin("pin", "env/thread");
    ThreadUndo.invalidate("pin", "env/thread");
    const secondUnpin = ThreadUndo.begin("pin", "env/thread");
    expect(firstUnpin.isCurrent()).toBe(false);
    expect(secondUnpin.isCurrent()).toBe(true);
    firstUnpin.finish();
    expect(secondUnpin.isCurrent()).toBe(true);
    secondUnpin.finish();
    expect(firstUnpin.isCurrent()).toBe(false);
    const allPins = ThreadUndo.begin("pin:all", "env/thread");
    const spacePins = ThreadUndo.begin("pin:space", "env/thread");
    ThreadUndo.invalidate("pin:all", "env/thread");
    expect(allPins.isCurrent()).toBe(false);
    expect(spacePins.isCurrent()).toBe(true);
    spacePins.finish();
  });

  it("expires an Undo without invalidating another environment or thread", () => {
    const first = ThreadUndo.begin("pin", "one/thread");
    const otherEnvironment = ThreadUndo.begin("pin", "two/thread");
    const otherThread = ThreadUndo.begin("pin", "one/other");
    first.finish();
    expect(first.isCurrent()).toBe(false);
    const allPins = ThreadUndo.begin("pin:all", "one/thread");
    const spacePins = ThreadUndo.begin("pin:space", "one/thread");
    ThreadUndo.invalidate("pin", "one/thread");
    expect(allPins.isCurrent()).toBe(false);
    expect(spacePins.isCurrent()).toBe(false);
    expect(otherEnvironment.isCurrent()).toBe(true);
    expect(otherThread.isCurrent()).toBe(true);
    otherEnvironment.finish();
    otherThread.finish();
  });
});
