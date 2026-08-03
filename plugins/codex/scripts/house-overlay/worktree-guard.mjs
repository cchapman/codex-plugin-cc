// worktree-guard.mjs — fail-closed worktree guard for --write dispatches.
// Faithful port of bin/codex-task.py write_guard (orchestration-primitives spec
// 2026-07-12; detached HEAD deliberately ALLOWED — see fork spec, decisions).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileP = promisify(execFile);

const SCRUB_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY", "GIT_INDEX_FILE"];

async function guardGit(repo, ...gitargs) {
  const env = { ...process.env };
  for (const k of SCRUB_VARS) delete env[k];
  const { stdout } = await execFileP("git", ["-C", repo, ...gitargs],
    { env, timeout: 30000 });
  return stdout.trim();
}

export async function defaultBranches(repo, gitRunner = guardGit) {
  try {
    const ref = await gitRunner(repo, "rev-parse", "--abbrev-ref", "origin/HEAD");
    const stripped = ref.startsWith("origin/") ? ref.slice("origin/".length) : "";
    if (stripped && stripped !== "HEAD") return new Set([stripped]);
    return new Set(["main", "master"]);
  } catch {
    return new Set(["main", "master"]);
  }
}

export async function writeGuard(repo, unsafe, gitRunner = guardGit) {
  try {
    if ((await gitRunner(repo, "rev-parse", "--is-inside-work-tree")) !== "true") {
      return "target is not inside a git work tree — Codex --write needs a linked worktree";
    }
  } catch (err) {
    return `cannot verify target is a git work tree (${err.message}) — fail-closed block`;
  }
  if (unsafe) return null;
  try {
    const paths = (await gitRunner(repo, "rev-parse", "--path-format=absolute",
      "--git-dir", "--git-common-dir")).split("\n");
    if (paths.length !== 2 || paths.some((p) => !p)) {
      return "unparseable git-dir probe output — fail-closed block";
    }
    if (paths[0] === paths[1]) {
      return "target is a primary/shared checkout (git-dir == git-common-dir; submodules count) — "
        + "create a linked worktree, or pass --unsafe-shared-checkout WITH explicit user "
        + "authorization quoted in-conversation";
    }
    const branch = await gitRunner(repo, "rev-parse", "--abbrev-ref", "HEAD");
    if ((await defaultBranches(repo, gitRunner)).has(branch)) {
      return `worktree is checked out on the default branch (${branch}) — Codex never writes `
        + "on the default branch; check out a feature branch in the worktree first";
    }
  } catch (err) {
    return `cannot verify target repo state (${err.message}) — fail-closed block`;
  }
  return null;
}

export const UNSAFE_BANNER = [
  "==========================================================================",
  "!!  --unsafe-shared-checkout: WORKTREE GUARD BYPASSED                   !!",
  "!!  Target: {repo}",
  "!!  Bypassed: primary-checkout block + default-branch block.            !!",
  "!!  Codex may now WRITE into a shared checkout. This flag requires      !!",
  "!!  explicit user authorization quoted in-conversation BEFORE dispatch  !!",
  "!!  (skills/codex-task/SKILL.md). If that quote is absent, STOP.        !!",
  "=========================================================================="
].join("\n") + "\n";

export function formatUnsafeBanner(repo) {
  return UNSAFE_BANNER.replace("{repo}", repo);
}
