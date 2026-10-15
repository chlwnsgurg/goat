// @vitest-environment jsdom
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { ThreadId, ProviderInstanceId, ProviderDriverKind } from "@goat/contracts";
import { act } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  createNativeMemoryHarness,
  renderNative,
  nativeEnv,
  type NativeMemoryHarness,
} from "../../testing/memoryNativeHarness";
vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("./SubagentStatusDot", () => ({
  SubagentStatusDot: () => null,
  SUBAGENT_TONE_TEXT_CLASS: {},
}));
import { SubagentRow } from "./SubagentRow";
let h: NativeMemoryHarness;
let view: ReturnType<typeof renderNative>;
afterEach(async () => {
  await view?.unmount();
  h?.dispose();
});
it("retains a delegated row's saved ceiling across actual connection grant revocation and legacy state", async () => {
  h = createNativeMemoryHarness();
  await h.waitForAtom(h.memory.upsert.permissionAtom(nativeEnv), Boolean);
  const source = Atom.make<Parameters<typeof SubagentRow>[0]["subagent"]>({
    threadId: ThreadId.make("synthetic-parent"),
    childThreadId: null,
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("synthetic-codex"),
    title: "Synthetic delegated work",
    prompt: "Synthetic task",
    status: "running",
    result: null,
    model: null,
    memoryGrantCeiling: "read_write",
  });
  function DelegatedRow() {
    const subagent = useAtomValue(source);
    const allowed = useAtomValue(h.memory.upsert.permissionAtom(nativeEnv));
    return (
      <>
        <span>{allowed ? "Connection can write" : "Connection grant revoked"}</span>
        <SubagentRow environmentId={nativeEnv} subagent={subagent} elapsed={null} />
      </>
    );
  }
  view = renderNative(h, <DelegatedRow />);
  await view.render();
  expect(view.container.textContent).toContain("Synthetic delegated work");
  expect(view.container.textContent).toContain(
    "Memory: read_write",
  );
  await act(async () => h.revoke());
  expect(view.container.textContent).toContain("Connection grant revoked");
  expect(view.container.textContent).toContain(
    "Memory: read_write",
  );
  await act(async () => {
    const { memoryGrantCeiling: _ceiling, ...legacy } = h.registry.get(source);
    h.registry.set(source, legacy);
  });
  expect(view.container.textContent).not.toContain("Memory:");
});
