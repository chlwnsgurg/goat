// @effect-diagnostics nodeBuiltinImport:off - Isolated native Electron integration fixture, never a GOAT install or user profile.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { expect, it } from "vite-plus/test";

// Opt in on a host with a display and the pinned Electron runtime installed.
it.skipIf(NodeProcess.env["GOAT_TEST_ELECTRON_POPUPS"] !== "1")(
  "retains a real webview opener, chained messages, POST, session, close and owner cleanup",
  async ({ onTestFinished }) => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-popup-electron-"));
    const source = await NodeFSP.readFile(new URL("./PopupLifecycle.ts", import.meta.url), "utf8");
    await NodeFSP.writeFile(
      NodePath.join(directory, "PopupLifecycle.mjs"),
      NodeModule.stripTypeScriptTypes(source),
    );
    await NodeFSP.copyFile(
      new URL("./fixtures/popup-lifecycle.electron.mjs", import.meta.url),
      NodePath.join(directory, "main.mjs"),
    );
    const executable: unknown = NodeModule.createRequire(import.meta.url)("electron");
    if (typeof executable !== "string") throw new Error("Electron runtime path is unavailable");
    const child = NodeChildProcess.spawn(executable, [NodePath.join(directory, "main.mjs")], {
      env: { ...NodeProcess.env, ELECTRON_RUN_AS_NODE: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    onTestFinished(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    expect(code, output).toBe(0);
    expect(output).toContain("POPUP_LIFECYCLE_PASS");
  },
  60_000,
);
