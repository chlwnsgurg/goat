// @effect-diagnostics nodeBuiltinImport:off - Reads the workflow as configuration and runs its bounded wait program in an isolated VM.
import * as NodeFSP from "node:fs/promises";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { fromYaml } from "@t3tools/shared/schemaYaml";

const decode = Schema.decodeUnknownEffect(
  fromYaml(
    Schema.Struct({
      jobs: Schema.Struct({
        build: Schema.Struct({
          steps: Schema.Array(
            Schema.Struct({
              name: Schema.optionalKey(Schema.String),
              if: Schema.optionalKey(Schema.String),
              run: Schema.optionalKey(Schema.String),
              env: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
              with: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
            }),
          ),
        }),
      }),
    }),
  ),
);

describe("desktop release runtime supply", () => {
  it.effect("uploads producer archives before waiting and packages the complete bundle", () =>
    Effect.gen(function* () {
      const raw = yield* Effect.tryPromise(() =>
        NodeFSP.readFile(
          new URL("../.github/workflows/release-desktop.yml", import.meta.url),
          "utf8",
        ),
      );
      const workflow = yield* decode(raw);
      const steps = workflow.jobs.build.steps;
      const index = (name: string) => {
        const i = steps.findIndex((step) => step.name === name);
        assert.isAtLeast(i, 0, name);
        return i;
      };
      assert.isBelow(
        index("Build resource monitor before CLI archive"),
        index("Stage resource monitor for the CLI archive"),
      );
      assert.isBelow(index("Upload CLI archive"), index("Wait for SSH runtime archives"));
      assert.isBelow(
        index("Wait for SSH runtime archives"),
        index("Download SSH runtime archives"),
      );
      assert.isBelow(index("Download SSH runtime archives"), index("Build desktop artifact"));
      const build = steps[index("Build desktop artifact")]!.run!;
      assert.include(build, "--ssh-runtime-archive-dir");
      assert.include(build, "--require-all-ssh-runtimes");
      const releaseRaw = yield* Effect.tryPromise(() =>
        NodeFSP.readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"),
      );
      const releases = yield* Schema.decodeUnknownEffect(
        fromYaml(
          Schema.Struct({
            jobs: Schema.Record(
              Schema.String,
              Schema.Struct({
                uses: Schema.optionalKey(Schema.String),
                with: Schema.optionalKey(
                  Schema.Struct({
                    platform: Schema.optionalKey(Schema.String),
                    arch: Schema.optionalKey(Schema.String),
                    cli_archive: Schema.optionalKey(Schema.Boolean),
                    label: Schema.optionalKey(Schema.String),
                  }),
                ),
              }),
            ),
          }),
        ),
      )(releaseRaw);
      for (const [platform, arch, label] of [
        ["mac", "arm64", "macOS arm64"],
        ["linux", "x64", "Linux x64"],
        ["linux", "arm64", "Linux arm64"],
      ]) {
        const producer = Object.values(releases.jobs).find(
          (job) =>
            job.uses === "./.github/workflows/release-desktop.yml" &&
            job.with?.platform === platform &&
            job.with?.arch === arch,
        );
        assert.equal(producer?.with?.cli_archive, true);
        assert.equal(producer?.with?.label, label);
      }
    }),
  );
  it.effect(
    "every reusable-workflow caller has valid bundle inputs and an acyclic producer DAG",
    () =>
      Effect.gen(function* () {
        const directory = new URL("../.github/workflows/", import.meta.url);
        const raw = yield* Effect.tryPromise(() =>
          NodeFSP.readFile(new URL("release-desktop.yml", directory), "utf8"),
        );
        const reusable = yield* decode(raw);
        const inputs = yield* Schema.decodeUnknownEffect(
          fromYaml(
            Schema.Struct({
              on: Schema.Struct({
                workflow_call: Schema.Struct({
                  inputs: Schema.Struct({
                    ssh_runtime_bundle: Schema.Struct({
                      type: Schema.String,
                      default: Schema.Boolean,
                      required: Schema.Boolean,
                    }),
                  }),
                }),
              }),
            }),
          ),
        )(raw);
        assert.equal(inputs.on.workflow_call.inputs.ssh_runtime_bundle.default, false);
        assert.equal(inputs.on.workflow_call.inputs.ssh_runtime_bundle.type, "boolean");
        assert.equal(inputs.on.workflow_call.inputs.ssh_runtime_bundle.required, false);
        const steps = reusable.jobs.build.steps;
        for (const name of ["Wait for SSH runtime archives", "Download SSH runtime archives"]) {
          assert.equal(steps.find((step) => step.name === name)?.if, "inputs.ssh_runtime_bundle");
        }
        const packageStep = steps.find((step) => step.name === "Build desktop artifact")!;
        assert.equal(
          packageStep.env?.T3CODE_DESKTOP_SSH_RUNTIME_BUNDLE_OPTIONAL,
          "${{ !inputs.ssh_runtime_bundle }}",
        );
        const decodeCaller = Schema.decodeUnknownEffect(
          fromYaml(
            Schema.Struct({
              jobs: Schema.Record(
                Schema.String,
                Schema.Struct({
                  uses: Schema.optionalKey(Schema.String),
                  needs: Schema.optionalKey(
                    Schema.Union([Schema.String, Schema.Array(Schema.String)]),
                  ),
                  with: Schema.optionalKey(
                    Schema.Struct({
                      platform: Schema.optionalKey(Schema.String),
                      arch: Schema.optionalKey(Schema.String),
                      cli_archive: Schema.optionalKey(Schema.Boolean),
                      ssh_runtime_bundle: Schema.optionalKey(Schema.Boolean),
                      label: Schema.optionalKey(Schema.String),
                    }),
                  ),
                }),
              ),
            }),
          ),
        );
        const callers: string[] = [];
        for (const file of yield* Effect.tryPromise(() => NodeFSP.readdir(directory))) {
          if (!/\.ya?ml$/.test(file)) continue;
          const workflow = yield* decodeCaller(
            yield* Effect.tryPromise(() => NodeFSP.readFile(new URL(file, directory), "utf8")),
          );
          const calls = Object.entries(workflow.jobs).filter(
            ([, job]) => job.uses === "./.github/workflows/release-desktop.yml",
          );
          for (const [id, job] of calls) {
            callers.push(`${file}:${id}`);
            const bundled = job.with?.ssh_runtime_bundle ?? false;
            const dependencies = (jobId: string, visiting = new Set<string>()): Set<string> => {
              assert.isFalse(visiting.has(jobId), `${file}: cyclic needs at ${jobId}`);
              const next = new Set(visiting).add(jobId);
              const needs = workflow.jobs[jobId]?.needs;
              const direct = typeof needs === "string" ? [needs] : (needs ?? []);
              const result = new Set(direct);
              for (const parent of direct) {
                assert.isDefined(workflow.jobs[parent], `${file}: missing dependency ${parent}`);
                for (const ancestor of dependencies(parent, next)) result.add(ancestor);
              }
              return result;
            };
            dependencies(id);
            if (bundled) {
              for (const [platform, arch, label] of [
                ["mac", "arm64", "macOS arm64"],
                ["linux", "x64", "Linux x64"],
                ["linux", "arm64", "Linux arm64"],
              ]) {
                const producer = calls.find(
                  ([, candidate]) =>
                    candidate.with?.cli_archive === true &&
                    candidate.with.platform === platform &&
                    candidate.with.arch === arch,
                );
                assert.isDefined(producer, `${file}:${id} lacks ${platform}-${arch} producer`);
                if (producer) {
                  assert.equal(producer[1].with?.label, label);
                  assert.isFalse(
                    dependencies(producer[0]).has(id),
                    `${file}: producer cannot depend on a job waiting for its artifact`,
                  );
                }
              }
            } else {
              assert.equal(
                file,
                "desktop-macos-preview-publish.yml",
                `${file}:${id} must explicitly opt in when producers exist`,
              );
              assert.equal(job.with?.cli_archive, false);
            }
            // Run the real argument-building shell, stopping before signing/building.
            const shell = packageStep
              .run!.slice(0, packageStep.run!.indexOf("has_all()"))
              .replaceAll("${{ inputs.ssh_runtime_bundle }}", String(bundled))
              .replace(/\$\{\{ inputs\.([^ }]+) \}\}/g, (_match, name: string) =>
                name === "version" ? "1.2.3" : "fixture",
              );
            const built = yield* Effect.tryPromise(() =>
              NodeUtil.promisify(NodeChildProcess.execFile)(
                "bash",
                ["-c", shell + '\nprintf "%s\\n" "${args[@]}"'],
                { env: { ...process.env, GITHUB_WORKSPACE: "/fixture/workspace" } },
              ),
            );
            assert.equal(built.stdout.includes("--ssh-runtime-archive-dir"), bundled);
            assert.equal(built.stdout.includes("--require-all-ssh-runtimes"), bundled);
            if (bundled) assert.include(built.stdout, "/fixture/workspace/ssh-runtime-archives");
          }
        }
        assert.equal(callers.length, 7);
        assert.equal(callers.filter((caller) => caller.startsWith("release.yml:")).length, 6);
        assert.include(callers, "desktop-macos-preview-publish.yml:build");
      }),
  );

  it.live.each([
    "ready",
    "failed",
    "expired",
    "missing",
    "api-error",
    "partial",
    "concluded-success",
  ] as const)("bounded artifact wait in a child process: %s", (mode) =>
    Effect.tryPromise(async () => {
      const raw = await NodeFSP.readFile(
        new URL("../.github/workflows/release-desktop.yml", import.meta.url),
        "utf8",
      );
      const run = raw
        .split("      - name: Wait for SSH runtime archives")[1]!
        .split("      - name: Download SSH runtime archives")[0]!;
      const code = run
        .split("<<'NODE'\n")[1]!
        .split("          NODE")[0]!
        .split("\n")
        .map((line) => line.slice(10))
        .join("\n");
      const harness = String.raw`
import vm from "node:vm";
let now=0, exited=false;
const logs=[], requested=[];
const mode=${JSON.stringify(mode)};
const context={
  process:{env:{GH_TOKEN:"sentinel-secret",GITHUB_API_URL:"https://api.invalid",GITHUB_REPOSITORY:"goat-si/goat",GITHUB_RUN_ID:"1",GITHUB_RUN_ATTEMPT:"1"},
    exit:()=>{exited=true;throw new Error("fixture-exit-0");}},
  console:{log:line=>logs.push(line)},Date:{now:()=>now},
  setTimeout:callback=>{now+=36*60_000;callback();},
  fetch:async url=>({ok:mode!=="api-error",status:401,json:async()=>{
    if(url.includes("/jobs?"))return {jobs:mode==="failed"||mode==="concluded-success"?[{name:"Desktop / Build Linux arm64",conclusion:mode==="failed"?"failure":"success"}]:[]};
    const name=new URL(url).searchParams.get("name");requested.push(name);
    return {artifacts:mode==="ready"||(mode==="partial"&&name!=="cli-linux-arm64")?[{expired:false}]:mode==="expired"?[{expired:true}]:[]};
  }})
};
let failure;
try{await vm.runInNewContext("(async()=>{"+${JSON.stringify(code)}+"})()",context);}catch(cause){failure=String(cause);}
console.log(JSON.stringify({exited,logs,requested,failure}));
`;
      const { stdout, stderr } = await NodeUtil.promisify(NodeChildProcess.execFile)(
        process.execPath,
        ["--input-type=module", "--eval", harness],
      );
      const result = JSON.parse(stdout) as {
        exited: boolean;
        logs: string[];
        requested: string[];
        failure?: string;
      };
      assert.equal(result.exited, mode === "ready");
      if (mode !== "ready") assert.isDefined(result.failure);
      if (mode === "failed" || mode === "concluded-success")
        assert.include(result.failure, "cli-linux-arm64");
      if (mode === "expired" || mode === "missing" || mode === "partial")
        assert.include(result.failure, "35 minutes");
      if (mode === "api-error") assert.include(result.failure, "401");
      else
        assert.deepEqual(result.requested, ["cli-mac-arm64", "cli-linux-x64", "cli-linux-arm64"]);
      assert.isFalse((stdout + stderr).includes("sentinel-secret"));
    }),
  );
});
