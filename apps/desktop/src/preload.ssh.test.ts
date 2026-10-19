import type { DesktopBridge } from "@goat/contracts";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

import * as IpcChannels from "./ipc/channels.ts";

const ipc = vi.hoisted(() => ({
  bridge: undefined as DesktopBridge | undefined,
  invoke: vi.fn<(channel: string, input: unknown) => Promise<unknown>>(),
  listeners: new Set<(event: unknown, id: unknown) => void>(),
}));

vi.mock("@clerk/electron/preload", () => ({ exposeClerkBridge: () => {} }));
vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, bridge: DesktopBridge) => {
      if (name === "desktopBridge") ipc.bridge = bridge;
    },
  },
  ipcRenderer: {
    sendSync: () => null,
    invoke: ipc.invoke,
    on: (_channel: string, listener: (event: unknown, id: unknown) => void) =>
      ipc.listeners.add(listener),
    removeListener: (_channel: string, listener: (event: unknown, id: unknown) => void) =>
      ipc.listeners.delete(listener),
  },
  webFrame: {},
  webUtils: {},
}));

beforeAll(async () => {
  vi.stubGlobal("window", { addEventListener: () => {} });
  await import("./preload.ts");
  vi.unstubAllGlobals();
});

const target = { alias: "box", hostname: "box.test", username: null, port: null };
const bootstrap = {
  target,
  httpBaseUrl: "http://127.0.0.1:3201/",
  wsBaseUrl: "ws://127.0.0.1:3201/",
  pairingToken: null,
};
const answer = (id: unknown) => {
  for (const listener of ipc.listeners) listener({}, id);
};

describe("SSH preparation progress in preload", () => {
  it("isolates simultaneous requests and never sends their callbacks over IPC", async () => {
    const pending: Array<{ requestId: string; finish: (value: unknown) => void }> = [];
    ipc.invoke.mockImplementation(
      (channel, input) =>
        new Promise((finish) => {
          expect(channel).toBe(IpcChannels.ENSURE_SSH_ENVIRONMENT_CHANNEL);
          const cloned = structuredClone(input) as { requestId: string; options: unknown };
          expect(cloned.options).toEqual({ issuePairingToken: false });
          pending.push({ requestId: cloned.requestId, finish });
        }),
    );
    const firstAnswer = vi.fn();
    const secondAnswer = vi.fn();
    const first = ipc.bridge!.ensureSshEnvironment(target, {
      issuePairingToken: false,
      onHostAnswered: firstAnswer,
    });
    const second = ipc.bridge!.ensureSshEnvironment(target, {
      issuePairingToken: false,
      onHostAnswered: secondAnswer,
    });
    expect(pending[0]!.requestId).not.toBe(pending[1]!.requestId);
    answer(pending[1]!.requestId);
    expect(firstAnswer).not.toHaveBeenCalled();
    expect(secondAnswer).toHaveBeenCalledTimes(1);
    answer(pending[1]!.requestId);
    expect(secondAnswer).toHaveBeenCalledTimes(1);
    pending[0]!.finish(bootstrap);
    await first;
    answer(pending[0]!.requestId);
    expect(firstAnswer).not.toHaveBeenCalled();
    pending[1]!.finish(bootstrap);
    await second;
    expect(ipc.listeners.size).toBe(0);
  });

  it("removes progress observers when preparation rejects", async () => {
    ipc.invoke.mockRejectedValueOnce(new Error("SSH login rejected"));
    await expect(
      ipc.bridge!.ensureSshEnvironment(target, { onHostAnswered: vi.fn() }),
    ).rejects.toThrow("SSH login rejected");
    expect(ipc.listeners.size).toBe(0);
  });
});
