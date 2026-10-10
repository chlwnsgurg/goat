import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const [sha, ref] = NodeProcess.argv.slice(2);
const workflowPath = ".github/workflows/goat-ci.yml";
const disabled = new Set((NodeProcess.env.GOAT_DISABLED_WORKFLOWS ?? "").split("\n"));
const labels = new Set(["self-hosted", "linux", "x64", "goat", "epyc"]);
const actions = new Set([
  "actions/checkout@v6",
  "voidzero-dev/setup-vp@v1",
  "actions/upload-artifact@v4",
]);
let status = 0;

function refuse(reason) {
  console.error(`goat pre-push: ${workflowPath} in ${ref} (${sha}): ${reason}; refusing to push`);
  status = 1;
}

function isMapping(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

// Load only an installed repository parser, choosing the first package name in lexical order.
function loadYaml() {
  const store = NodePath.join(root, "node_modules/.pnpm");
  const name = NodeFS.readdirSync(store)
    .filter((entry) => entry.startsWith("yaml@2."))
    .sort()[0];
  if (!name) throw new Error("missing yaml");
  const packageDir = NodePath.join(store, name, "node_modules/yaml");
  const metadata = JSON.parse(
    NodeFS.readFileSync(NodePath.join(packageDir, "package.json"), "utf8"),
  );
  if (typeof metadata.version !== "string" || !metadata.version.startsWith("2.")) {
    throw new Error("wrong yaml version");
  }
  const entry = NodeModule.createRequire(import.meta.url).resolve(packageDir);
  return NodeModule.createRequire(entry)(entry);
}

// Aliased keys are resolved by toJS; also reject merge keys outside the validated fields.
function rejectMergeKeys(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Object.hasOwn(value, "<<")) throw new Error("merge key");
  for (const item of Object.values(value)) rejectMergeKeys(item, seen);
}

function validateWorkflow(source, yaml) {
  let workflow;
  try {
    const doc = yaml.parseDocument(source, { version: "1.2", uniqueKeys: true, merge: false });
    if (doc.errors.length > 0 || doc.directives.yaml.version !== "1.2") {
      throw new Error("invalid document");
    }
    yaml.visit(doc, {
      Pair(_key, pair) {
        if (yaml.isScalar(pair.key) && pair.key.value === "<<") throw new Error("merge key");
      },
    });
    workflow = doc.toJS({ maxAliasCount: 100 });
    rejectMergeKeys(workflow);
  } catch {
    refuse("invalid YAML");
    return;
  }

  if (!isMapping(workflow)) return refuse("root must be a mapping");
  if (
    !isMapping(workflow.on) ||
    Object.keys(workflow.on).length === 0 ||
    Object.keys(workflow.on).some(
      (event) => !["push", "pull_request", "workflow_dispatch"].includes(event),
    )
  ) {
    return refuse(
      "on must be a nonempty mapping containing only push, pull_request, workflow_dispatch",
    );
  }
  if (
    !isMapping(workflow.jobs) ||
    Object.keys(workflow.jobs).length !== 1 ||
    !Object.hasOwn(workflow.jobs, "ci")
  ) {
    return refuse("jobs must contain exactly ci");
  }
  const job = workflow.jobs.ci;
  if (!isMapping(job)) return refuse("jobs.ci must be a mapping");
  if (Object.hasOwn(job, "uses")) return refuse("jobs.ci.uses is forbidden");
  if (Object.hasOwn(job, "container") || Object.hasOwn(job, "services")) {
    return refuse("jobs.ci.container and jobs.ci.services are forbidden");
  }
  const runners = job["runs-on"];
  if (
    !Array.isArray(runners) ||
    runners.length !== 5 ||
    new Set(runners).size !== 5 ||
    runners.some((label) => typeof label !== "string" || !labels.has(label))
  ) {
    return refuse("jobs.ci.runs-on must contain exactly self-hosted, linux, x64, goat, epyc");
  }
  if (
    !Array.isArray(job.steps) ||
    job.steps.length === 0 ||
    job.steps.some((step) => !isMapping(step))
  ) {
    return refuse("jobs.ci.steps must be a nonempty array of mappings");
  }
  for (const [index, step] of job.steps.entries()) {
    if (Object.hasOwn(step, "run") === Object.hasOwn(step, "uses")) {
      refuse(`step ${index} must contain exactly one of run or uses`);
    } else if (Object.hasOwn(step, "uses") && !actions.has(step.uses)) {
      refuse(`step ${index}.uses is not an allowed action`);
    }
  }
}

let paths;
try {
  paths = NodeChildProcess.execFileSync(
    "git",
    ["ls-tree", "-rz", "--name-only", sha, "--", ".github/workflows"],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  )
    .split("\0")
    .filter(Boolean);
} catch {
  console.error(
    `goat pre-push: cannot enumerate pushed workflows in ${ref} (${sha}); refusing to push`,
  );
  NodeProcess.exit(1);
}
for (const path of paths) {
  if (path !== workflowPath && /\.ya?ml$/.test(path) && !disabled.has(path)) {
    console.error(`goat pre-push: ${path} in ${ref} is not disabled on goat-si/goat`);
    status = 1;
  }
}
if (paths.includes(workflowPath)) {
  let source;
  try {
    source = NodeChildProcess.execFileSync("git", ["show", `${sha}:${workflowPath}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    refuse("cannot read pushed workflow");
    NodeProcess.exit(1);
  }
  let yaml;
  try {
    yaml = loadYaml();
  } catch {
    console.error(
      "goat pre-push: repository yaml@2.* is unavailable or unloadable; run vp i; refusing to push",
    );
    NodeProcess.exit(1);
  }
  validateWorkflow(source, yaml);
}
if (status !== 0) NodeProcess.exit(status);
