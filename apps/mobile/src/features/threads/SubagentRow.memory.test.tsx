// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  createNativeMemoryHarness,
  renderNative,
  type NativeMemoryHarness,
} from "../../testing/memoryNativeHarness";
vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("./SubagentStatusDot", () => ({
  SubagentStatusDot: () => null,
  SUBAGENT_TONE_TEXT_CLASS: {},
}));
import { SubagentMemoryAccess } from "./SubagentRow";
let h: NativeMemoryHarness;
let view: ReturnType<typeof renderNative>;
afterEach(async () => {
  await view?.unmount();
  h?.dispose();
});
it("updates saved access while leaving effective access unknown, including legacy none", async () => {
  h = createNativeMemoryHarness();
  view = renderNative(h, <SubagentMemoryAccess subagent={{ memoryGrantCeiling: "read_write" }} />);
  await view.render();
  expect(view.container.textContent).toContain(
    "Saved memory access: read_write · Effective access: unknown",
  );
  await view.rerender(<SubagentMemoryAccess subagent={{}} />);
  expect(view.container.textContent).toContain(
    "Saved memory access: none · Effective access: unknown",
  );
});
