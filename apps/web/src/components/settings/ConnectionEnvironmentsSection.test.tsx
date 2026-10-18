// @vitest-environment jsdom
import * as Cause from "effect/Cause";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  connectPairing: vi.fn(),
  sshHosts: null as unknown,
}));

vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [] }),
  usePrimaryEnvironment: () => ({
    environmentId: "primary",
    label: "This Mac",
    entry: { target: { _tag: "PrimaryConnectionTarget", httpBaseUrl: "http://localhost:3773" } },
  }),
  useRelayEnvironmentDiscovery: () => ({ environments: new Map() }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("../../connection/onboarding", () => ({
  connectPairing: state.connectPairing,
  connectSshEnvironment: vi.fn(),
}));
vi.mock("../../connection/catalog", () => ({
  environmentCatalog: { remove: vi.fn(), register: vi.fn(), setEnabled: vi.fn() },
}));
vi.mock("../../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig } = await import("@goat/shared/keybindings");
  return {
    primaryServerKeybindingsAtom: Atom.make(
      compileResolvedKeybindingsConfig([
        { key: "mod+1", command: "thread.jump.1" },
        { key: "mod+2", command: "thread.jump.2" },
      ]),
    ),
    serverEnvironment: {
      probeSshHost: vi.fn(),
      trustSshHost: Object.assign(vi.fn(), { permissionAtom: () => Atom.make(false) }),
      forgetSshHost: vi.fn(),
      updateStateAtom: () => Atom.make({ status: "idle" }),
    },
  };
});
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: state.sshHosts,
    isPending: false,
    error: null,
    refresh: () => {},
  }),
}));
vi.mock(import("../../cloud/publicConfig"), async (importOriginal) => ({
  ...(await importOriginal()),
  hasCloudPublicConfig: () => false,
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: (toast: unknown) => toast,
}));

import { ConnectionEnvironmentsSection } from "./ConnectionEnvironmentsSection";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.connectPairing.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  state.sshHosts = null;
  delete (window as { desktopBridge?: unknown }).desktopBridge;
});

const flush = () => act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));

function button(name: string, scope: ParentNode = document) {
  const match = [...scope.querySelectorAll("button")].find(
    (element) =>
      element.getAttribute("aria-label") === name || element.textContent?.trim() === name,
  );
  if (!match) throw new Error(`No button named ${name}`);
  return match;
}

function input(placeholder: string) {
  const match = document.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`);
  if (!match) throw new Error(`No input with placeholder ${placeholder}`);
  return match;
}

function type(element: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setValue.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function openAddDialog() {
  await act(async () => {
    root.render(<ConnectionEnvironmentsSection title="Connections" searchable={false} />);
  });
  await act(async () => button("Add environment").click());
  await flush();
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!dialog) throw new Error("Add environment dialog did not open");
  return dialog;
}

it("shows the empty state when no machines are saved", async () => {
  await act(async () => {
    root.render(<ConnectionEnvironmentsSection title="Connections" searchable={false} />);
  });
  expect(container.textContent).toContain("Connections");
  expect(container.textContent).toContain("No saved remote environments");
});

it("pairs a pasted pairing URL and closes the dialog", async () => {
  state.connectPairing.mockResolvedValue({ _tag: "Success", value: undefined });
  const dialog = await openAddDialog();

  type(input("backend.example.com"), "https://box.example.com/pair#token=PAIR1234");
  expect(input("PAIRCODE").value).toBe("PAIR1234");

  await act(async () => button("Add environment", dialog).click());
  await flush();

  expect(state.connectPairing).toHaveBeenCalledWith({
    host: "https://box.example.com",
    pairingCode: "PAIR1234",
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("keeps the dialog open with the error when pairing fails", async () => {
  state.connectPairing.mockResolvedValue({
    _tag: "Failure",
    cause: Cause.fail(new Error("Pairing code expired")),
  });
  const dialog = await openAddDialog();

  type(input("backend.example.com"), "box.example.com");
  type(input("PAIRCODE"), "OLDCODE");
  await act(async () => button("Add environment", dialog).click());
  await flush();

  expect(state.connectPairing).toHaveBeenCalledWith({
    host: "box.example.com",
    pairingCode: "OLDCODE",
  });
  const open = document.querySelector('[role="dialog"]');
  expect(open?.textContent).toContain("Pairing code expired");
});

it("keeps thread jump chords inside the SSH host suggestions", async () => {
  const resolveSshHost = vi.fn(async () => ({
    alias: "devbox",
    hostname: "devbox.local",
    username: null,
    port: null,
  }));
  (window as { desktopBridge?: unknown }).desktopBridge = { resolveSshHost };
  state.sshHosts = [{ alias: "devbox", hostname: "devbox.local", username: null, port: null }];
  const dialog = await openAddDialog();
  const sshMode = [...dialog.querySelectorAll("button")].find((element) =>
    element.textContent?.startsWith("SSH"),
  );
  await act(async () => sshMode!.click());
  await flush();
  const hostInput = document.querySelector<HTMLInputElement>("#saved-backend-ssh-host")!;
  await act(async () => {
    hostInput.focus();
    hostInput.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  await flush();

  const chord = (key: string) =>
    new KeyboardEvent("keydown", {
      key,
      code: `Digit${key}`,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
  // The second jump has no host behind it; it must not reach the thread sidebar's window listener.
  let notCanceled = true;
  act(() => {
    notCanceled = hostInput.dispatchEvent(chord("2"));
  });
  expect(notCanceled).toBe(false);
  expect(resolveSshHost).not.toHaveBeenCalled();

  await act(async () => {
    hostInput.dispatchEvent(chord("1"));
  });
  await flush();
  expect(resolveSshHost).toHaveBeenCalledWith("devbox");
});
