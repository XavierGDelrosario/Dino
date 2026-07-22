// Global test setup, applied to every suite via vitest.config.ts `setupFiles`.
//
// `useStickyState` holds tab-surviving UI state (Lists filters, Translate input,
// the active tab) in a MODULE-SCOPE cache — that's what lets it outlive a view
// unmount. Module state is shared by every test in a file, so without this a
// filter set in one case leaks into the next and reds it on an unrelated
// assertion. Clear between cases so each starts from the resting UI.
import { afterEach } from "vitest";
import { resetStickyState } from "@/hooks/useStickyState";

afterEach(() => {
  resetStickyState();
});
