import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  writeGuard, defaultBranches, UNSAFE_BANNER, formatUnsafeBanner
} from "../plugins/codex/scripts/house-overlay/worktree-guard.mjs";

const mkTmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function fxGit(repo, ...args) {
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

// All fixtures share one GIT_CEILING_DIRECTORIES base so a plain (non-git)
// fixture dir never "finds" an enclosing repo, mirroring bin/codex-task.py's
// _selftest. Every case is computed once in `before`, into `results`, so
// individual tests only assert — the mutating steps (branch parking, env-var
// leak simulation) must happen in a fixed order, which a shared setup
// function guarantees regardless of node:test's own ordering/concurrency.
let base;
let oldCeiling;
const results = {};

before(async () => {
  base = mkTmp("wtguard.");
  oldCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = base;

  const primary = path.join(base, "primary");
  fs.mkdirSync(primary);
  fxGit(primary, "init", "-q", "-b", "main");
  fxGit(primary, "-c", "user.email=t@t", "-c", "user.name=t",
    "commit", "--allow-empty", "-q", "-m", "init");
  results.primary_blocked = await writeGuard(primary, false);
  results.primary_unsafe_allowed = await writeGuard(primary, true);

  // linked worktree on a feature branch -> allowed
  const wtFeat = path.join(base, "wt-feat");
  fxGit(primary, "worktree", "add", "-q", "-b", "feat-x", wtFeat);
  results.worktree_feature_allowed = await writeGuard(wtFeat, false);

  // env-leak defeat attempt: a caller-exported GIT_DIR pointing at a linked
  // worktree's gitdir must NOT make the primary checkout pass.
  const wtGitdir = path.join(primary, ".git", "worktrees", "wt-feat");
  const oldGitDir = process.env.GIT_DIR;
  process.env.GIT_DIR = wtGitdir;
  try {
    results.env_leak_still_blocked = await writeGuard(primary, false);
  } finally {
    if (oldGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = oldGitDir;
  }

  // slash-containing default branch (e.g. release/stable): the default-branch
  // block must fire on the FULL ref, not a last-path-component reduction.
  const remote = path.join(base, "slashremote.git");
  fxGit(base, "init", "--bare", "-q", "-b", "release/stable", remote);
  const slashclone = path.join(base, "slashclone");
  fxGit(base, "clone", "-q", remote, slashclone);
  fxGit(slashclone, "-c", "user.email=t@t", "-c", "user.name=t",
    "commit", "--allow-empty", "-q", "-m", "init");
  fxGit(slashclone, "push", "-q", "origin", "release/stable");
  fxGit(slashclone, "remote", "set-head", "origin", "release/stable");
  // park the clone off the default, add a worktree ON release/stable
  fxGit(slashclone, "checkout", "-q", "-b", "parking2");
  const wtSlash = path.join(base, "wt-slash");
  fxGit(slashclone, "worktree", "add", "-q", wtSlash, "release/stable");
  results.slash_default_blocked = await writeGuard(wtSlash, false);

  // linked worktree ON the default branch -> blocked (park primary elsewhere
  // first: git refuses the same branch checked out in two worktrees)
  fxGit(primary, "checkout", "-q", "-b", "parking");
  // check 2 in isolation: primary is now on non-default 'parking', so ONLY
  // the git-dir==git-common-dir block can catch it.
  results.primary_nondefault_blocked = await writeGuard(primary, false);

  // GIT_COMMON_DIR leak: a leaked common-dir pointing at a DIFFERENT valid
  // repo makes git-dir != git-common-dir for the primary, bypassing check 2;
  // primary is on non-default 'parking' here so check 3 cannot mask it.
  const leakOther = path.join(base, "leak-other");
  fs.mkdirSync(leakOther);
  fxGit(leakOther, "init", "-q", "-b", "main");
  fxGit(leakOther, "-c", "user.email=t@t", "-c", "user.name=t",
    "commit", "--allow-empty", "-q", "-m", "init");
  const oldCommonDir = process.env.GIT_COMMON_DIR;
  process.env.GIT_COMMON_DIR = path.join(leakOther, ".git");
  try {
    results.env_leak_commondir_still_blocked = await writeGuard(primary, false);
  } finally {
    if (oldCommonDir === undefined) delete process.env.GIT_COMMON_DIR;
    else process.env.GIT_COMMON_DIR = oldCommonDir;
  }

  const wtMain = path.join(base, "wt-main");
  fxGit(primary, "worktree", "add", "-q", wtMain, "main");
  results.worktree_default_blocked = await writeGuard(wtMain, false);

  // detached-HEAD worktree -> allowed (abbrev-ref returns literal HEAD)
  const wtDet = path.join(base, "wt-det");
  fxGit(primary, "worktree", "add", "-q", "--detach", wtDet);
  results.worktree_detached_allowed = await writeGuard(wtDet, false);

  // submodule checkout -> blocked (git-dir == git-common-dir, intended)
  const subSrc = path.join(base, "subsrc");
  fs.mkdirSync(subSrc);
  fxGit(subSrc, "init", "-q", "-b", "main");
  fxGit(subSrc, "-c", "user.email=t@t", "-c", "user.name=t",
    "commit", "--allow-empty", "-q", "-m", "init");
  const superRepo = path.join(base, "super");
  fs.mkdirSync(superRepo);
  fxGit(superRepo, "init", "-q", "-b", "main");
  fxGit(superRepo, "-c", "user.email=t@t", "-c", "user.name=t",
    "commit", "--allow-empty", "-q", "-m", "init");
  fxGit(superRepo, "-c", "protocol.file.allow=always",
    "submodule", "add", "-q", subSrc, "sub");
  results.submodule_blocked = await writeGuard(path.join(superRepo, "sub"), false);

  // non-git path -> blocked, override or not (check 1 is never bypassable)
  const plain = path.join(base, "plain");
  fs.mkdirSync(plain);
  results.non_git_blocked = await writeGuard(plain, false);
  results.non_git_override_blocked = await writeGuard(plain, true);

  // git failure simulation: a .git FILE pointing nowhere -> git errors -> block
  const broken = path.join(base, "broken");
  fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, ".git"), "gitdir: /nonexistent-target\n");
  results.git_failure_blocked = await writeGuard(broken, false);

  // check 1's "false" branch (distinct from the git-error branch): a path
  // INSIDE .git is a real git location but not a work tree.
  results.inside_gitdir_blocked = await writeGuard(path.join(primary, ".git"), false);
});

after(() => {
  if (oldCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
  else process.env.GIT_CEILING_DIRECTORIES = oldCeiling;
  fs.rmSync(base, { recursive: true, force: true });
});

test("primary/shared checkout blocked", () => {
  assert.notEqual(results.primary_blocked, null);
});
test("primary/shared checkout allowed with unsafe override", () => {
  assert.equal(results.primary_unsafe_allowed, null);
});
test("linked worktree on a feature branch allowed", () => {
  assert.equal(results.worktree_feature_allowed, null);
});
test("leaked GIT_DIR does not bypass the primary-checkout block", () => {
  assert.notEqual(results.env_leak_still_blocked, null);
});
test("slash-containing default branch blocked on the full ref", () => {
  assert.notEqual(results.slash_default_blocked, null);
});
test("primary on a non-default branch still blocked (check 2 in isolation)", () => {
  assert.notEqual(results.primary_nondefault_blocked, null);
});
test("leaked GIT_COMMON_DIR does not bypass the primary-checkout block", () => {
  assert.notEqual(results.env_leak_commondir_still_blocked, null);
});
test("linked worktree on the default branch blocked", () => {
  assert.notEqual(results.worktree_default_blocked, null);
});
test("linked worktree with detached HEAD allowed", () => {
  assert.equal(results.worktree_detached_allowed, null);
});
test("submodule checkout blocked", () => {
  assert.notEqual(results.submodule_blocked, null);
});
test("non-git path blocked", () => {
  assert.notEqual(results.non_git_blocked, null);
});
test("non-git path blocked even with unsafe override (check 1 never bypassable)", () => {
  assert.notEqual(results.non_git_override_blocked, null);
});
test("git failure (broken .git file) blocks (fail-closed)", () => {
  assert.notEqual(results.git_failure_blocked, null);
});
test("path inside .git dir blocked (not a work tree)", () => {
  assert.notEqual(results.inside_gitdir_blocked, null);
});

test("defaultBranches: origin/main -> {main}", async () => {
  const fake = async () => "origin/main";
  assert.deepEqual(await defaultBranches("x", fake), new Set(["main"]));
});
test("defaultBranches: origin/release/stable -> {release/stable}", async () => {
  const fake = async () => "origin/release/stable";
  assert.deepEqual(await defaultBranches("x", fake), new Set(["release/stable"]));
});
test("defaultBranches: literal origin/HEAD -> {main,master} fallback", async () => {
  const fake = async () => "origin/HEAD";
  assert.deepEqual(await defaultBranches("x", fake), new Set(["main", "master"]));
});
test("defaultBranches: bare origin -> {main,master} fallback", async () => {
  const fake = async () => "origin";
  assert.deepEqual(await defaultBranches("x", fake), new Set(["main", "master"]));
});

test("UNSAFE_BANNER carries the conspicuous bypass marker", () => {
  assert.match(UNSAFE_BANNER, /GUARD BYPASSED/);
});
test("formatUnsafeBanner interpolates the target repo path", () => {
  const out = formatUnsafeBanner("/some/repo");
  assert.match(out, /GUARD BYPASSED/);
  assert.ok(out.includes("/some/repo"));
});
