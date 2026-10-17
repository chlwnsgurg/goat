// @effect-diagnostics nodeBuiltinImport:off - runs before `vp i`, so only Node built-ins exist.
/**
 * Worktree setup, run as `node scripts/setup-worktree.ts` by the t3.json
 * "Setup Worktree" action and by the `.vite-hooks/post-checkout` hook when
 * `git worktree add` creates a checkout. Plain Node keeps one command working
 * in every shell GOAT spawns (zsh, bash, fish, PowerShell): it installs
 * dependencies, links the main checkout's gitignored env files into this
 * worktree, then warms the web dependency cache.
 *
 * Workspace packages do not resolve until `vp i` finishes, so this file may
 * import only Node built-ins.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const ENV_FILES = [".env", NodePath.join("infra", "relay", ".env")];

const worktree = NodePath.dirname(import.meta.dirname);

// GOAT passes the project root, older builds under its legacy T3 name. The git
// hook passes neither; the main worktree is the first `git worktree list` entry.
function mainWorktree(): string {
  const list = NodeChildProcess.execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: worktree,
    encoding: "utf8",
  });
  const first = list.split("\n", 1)[0] ?? "";
  if (!first.startsWith("worktree ")) {
    throw new Error("Could not find the main worktree in `git worktree list --porcelain`.");
  }
  return first.slice("worktree ".length);
}
const projectRoot =
  process.env.GOAT_PROJECT_ROOT || process.env.T3CODE_PROJECT_ROOT || mainWorktree();

// `shell` resolves `vp` through PATH, including Windows command shims.
// Setup has no one answering install prompts. Pass pnpm's confirmation flag
// through vp and leave stdin closed so other prompts fail instead of hanging.
const install = NodeChildProcess.spawnSync("vp i -- --yes", {
  cwd: worktree,
  shell: true,
  stdio: ["ignore", "inherit", "inherit"],
});
if (install.status !== 0) process.exit(install.status ?? 1);

// Env files live as real files in the main checkout; worktrees only get
// symlinks to them. Only a symlink is ever replaced, so a real env file is
// never deleted, including when this runs in the main checkout itself.
for (const file of ENV_FILES) {
  const source = NodePath.join(projectRoot, file);
  const sourceStat = NodeFS.lstatSync(source, { throwIfNoEntry: false });
  if (!sourceStat) continue;
  if (!sourceStat.isFile()) {
    process.stderr.write(`Skipping ${file}: ${source} is not a regular file.\n`);
    continue;
  }
  const target = NodePath.join(worktree, file);
  const existing = NodeFS.lstatSync(target, { throwIfNoEntry: false });
  if (existing && !existing.isSymbolicLink()) continue;
  if (existing) NodeFS.rmSync(target);
  NodeFS.symlinkSync(source, target);
}

const warm = NodeChildProcess.spawnSync(
  process.execPath,
  [NodePath.join(worktree, "apps", "web", "scripts", "warm-dep-cache.ts")],
  { cwd: worktree, stdio: "inherit" },
);
process.exit(warm.status ?? 1);
