import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { readOnlyProxyJumpArgs } from "./probeOptions.ts";
import { runPreflightProcess } from "./preflightProcess.ts";

it.effect.each([
  ["bastion", [{ host: "bastion" }]],
  ["deploy@bastion:2222", [{ host: "bastion", user: "deploy", port: "2222" }]],
  [
    "first,jump@[2001:db8::2]:2200,last",
    [{ host: "last" }, { host: "2001:db8::2", user: "jump", port: "2200" }, { host: "first" }],
  ],
  ["jump'$(touch should-not-exist)%h", [{ host: "jump'$(touch should-not-exist)%h" }]],
] as const)("protects every child in ProxyJump %s and preserves its argv", ([chain, hops]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-proxy-" });
    const ssh = `${directory}/ssh with 'quotes'`;
    yield* fs.writeFileString(ssh, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
    yield* fs.chmod(ssh, 0o700);
    let proxy = readOnlyProxyJumpArgs(ssh, new Map([["proxyjump", chain]]))[1]!.slice(
      "ProxyCommand=".length,
    );
    for (const hop of hops) {
      // OpenSSH expands tokens before handing ProxyCommand to the shell.
      const expanded = proxy.replace(/%%|%h|%p/gu, (token) =>
        token === "%%" ? "%" : token === "%h" ? "destination.example" : "22",
      );
      const child = yield* runPreflightProcess("/bin/sh", ["-c", expanded]);
      expect(child.exitCode).toBe(0);
      const args = child.stdout.trimEnd().split("\n");
      expect(args.slice(-2)).toEqual(["--", hop.host]);
      expect(args.slice(args.indexOf("-W"), args.indexOf("-W") + 2)).toEqual([
        "-W",
        "[destination.example]:22",
      ]);
      for (const option of [
        "ControlMaster=no",
        "ControlPath=none",
        "BatchMode=yes",
        "UpdateHostKeys=no",
        "PermitLocalCommand=no",
        "ClearAllForwardings=yes",
        "RequestTTY=no",
        "RemoteCommand=none",
        "StrictHostKeyChecking=yes",
        "ForwardAgent=no",
        "ForwardX11=no",
      ])
        expect(args).toContain(option);
      if ("user" in hop)
        expect(args.slice(args.indexOf("-l"), args.indexOf("-l") + 2)).toEqual(["-l", hop.user]);
      if ("port" in hop)
        expect(args.slice(args.indexOf("-p"), args.indexOf("-p") + 2)).toEqual(["-p", hop.port]);
      proxy =
        args.find((arg) => arg.startsWith("ProxyCommand="))?.slice("ProxyCommand=".length) ?? "";
    }
    expect(proxy).toBe("");
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.each([undefined, "none"])("keeps custom routing when ProxyJump is %s", (jump) => {
  expect(readOnlyProxyJumpArgs("ssh", new Map(jump ? [["proxyjump", jump]] : []))).toEqual([]);
});
