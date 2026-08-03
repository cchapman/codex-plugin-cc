import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "plugins/codex/scripts/house-overlay/task-entry.mjs");
const FAKE = path.join(ROOT, "tests/fixtures/fake-companion.mjs");

const mkTmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function fxGit(repo, ...args) {
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

function gitRepo() {
  const repo = mkTmp("house-task-entry-repo-");
  fxGit(repo, "init", "-q", "-b", "main");
  fxGit(repo, "-c", "user.email=t@t", "-c", "user.name=t",
    "commit", "--allow-empty", "-q", "-m", "init");
  return repo;
}

// A primary checkout plus a linked feature-branch worktree off it — the
// guard-wiring/provenance tests need both a blocked target and an allowed one.
function primaryAndWorktree() {
  const base = mkTmp("house-task-entry-wt-");
  const primary = path.join(base, "primary");
  fs.mkdirSync(primary);
  fxGit(primary, "init", "-q", "-b", "main");
  fxGit(primary, "-c", "user.email=t@t", "-c", "user.name=t",
    "commit", "--allow-empty", "-q", "-m", "init");
  const wt = path.join(base, "wt-feat");
  fxGit(primary, "worktree", "add", "-q", "-b", "feat-x", wt);
  return { primary, wt };
}

function runEntry(repo, { mode = "ok", extraArgs = [], extraEnv = {}, jobId = "task-t1", input = "prompt\n" } = {}) {
  // Scrub any TASK_DEADLINE_MS inherited from this process's own environment
  // so the env-fallback and default-deadline tests are deterministic — only
  // extraEnv may (re)introduce it.
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: mkTmp("house-task-entry-state-"), FAKE_MODE: mode };
  delete env.TASK_DEADLINE_MS;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath,
    [ENTRY, "--job-id", jobId, "--cwd", repo, "--companion", FAKE, ...extraArgs],
    { input, encoding: "utf8", timeout: 60000, env });
}

test("healthy read-only task -> exit 0", () => {
  assert.equal(runEntry(gitRepo()).status, 0);
});
test("worker fails -> exit 1", () => {
  const r = runEntry(gitRepo(), { mode: "fail" });
  assert.equal(r.status, 1);
});
test("clean exit + nonterminal job -> exit 1", () => {
  const r = runEntry(gitRepo(), { mode: "early-exit" });
  assert.equal(r.status, 1);
});
test("empty prompt without --resume-last -> usage exit 2", () => {
  const r = runEntry(gitRepo(), { input: "" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /empty prompt/);
});
test("empty prompt WITH --resume-last is NOT a usage error (proceeds to the companion)", () => {
  const argvFile = path.join(mkTmp("house-task-entry-argv-"), "argv.json");
  const r = runEntry(gitRepo(),
    { input: "", extraArgs: ["--resume-last"], extraEnv: { FAKE_ARGV_DUMP: argvFile } });
  assert.equal(r.status, 0);
  const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
  assert.ok(argv.includes("--resume-last"), "expected --resume-last forwarded into companion argv");
});

test("guard: --write against a PRIMARY checkout -> exit 2, blocked, companion not spawned", () => {
  const marker = path.join(mkTmp("house-task-entry-marker-"), "spawned");
  const r = runEntry(gitRepo(), { extraArgs: ["--write"], extraEnv: { FAKE_SPAWN_MARKER: marker } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /write dispatch blocked/);
  assert.ok(!fs.existsSync(marker), "companion was spawned despite the guard block");
});
test("guard: --write in a linked feature-branch worktree -> exit 0", () => {
  const { wt } = primaryAndWorktree();
  const r = runEntry(wt, { extraArgs: ["--write"] });
  assert.equal(r.status, 0);
});
test("guard: --write --unsafe-shared-checkout on a primary -> exit 0 AND stdout carries the bypass banner", () => {
  const r = runEntry(gitRepo(), { extraArgs: ["--write", "--unsafe-shared-checkout"] });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /GUARD BYPASSED/);
});

test("provenance (CXR-003): --write in a linked worktree stamps the Codex author identity", () => {
  const { wt } = primaryAndWorktree();
  const envDump = path.join(mkTmp("house-task-entry-env-"), "env.json");
  const r = runEntry(wt, { extraArgs: ["--write"], extraEnv: { FAKE_ENV_DUMP: envDump } });
  assert.equal(r.status, 0);
  const dumped = JSON.parse(fs.readFileSync(envDump, "utf8"));
  assert.equal(dumped.GIT_AUTHOR_NAME, "Codex (gpt-5.6)");
  assert.equal(dumped.GIT_AUTHOR_EMAIL, "codex@openai.local");
});
test("provenance (CXR-003): without --write, the author identity is NOT stamped", () => {
  const envDump = path.join(mkTmp("house-task-entry-env-"), "env.json");
  const r = runEntry(gitRepo(), { extraEnv: { FAKE_ENV_DUMP: envDump } });
  assert.equal(r.status, 0);
  const dumped = JSON.parse(fs.readFileSync(envDump, "utf8"));
  assert.equal(dumped.GIT_AUTHOR_NAME, null);
  assert.equal(dumped.GIT_AUTHOR_EMAIL, null);
});

test("invalid --deadline-ms -> usage exit 2, companion not spawned", () => {
  const marker = path.join(mkTmp("house-task-entry-marker-"), "spawned");
  const r = runEntry(gitRepo(),
    { extraArgs: ["--deadline-ms", "abc"], extraEnv: { FAKE_SPAWN_MARKER: marker } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /invalid --deadline-ms/);
  assert.ok(!fs.existsSync(marker), "companion was spawned despite the invalid --deadline-ms");
});
test("TASK_DEADLINE_MS env fallback is forwarded to the companion when --deadline-ms is absent", () => {
  const argvFile = path.join(mkTmp("house-task-entry-argv-"), "argv.json");
  const r = runEntry(gitRepo(),
    { extraEnv: { TASK_DEADLINE_MS: "12345", FAKE_ARGV_DUMP: argvFile } });
  assert.equal(r.status, 0);
  const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
  const i = argv.indexOf("--deadline-ms");
  assert.ok(i !== -1 && argv[i + 1] === "12345", "expected --deadline-ms 12345 in companion argv");
});
test("default deadline (no flag, no env) is 3600000ms", () => {
  const argvFile = path.join(mkTmp("house-task-entry-argv-"), "argv.json");
  const r = runEntry(gitRepo(), { extraEnv: { FAKE_ARGV_DUMP: argvFile } });
  assert.equal(r.status, 0);
  const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
  const i = argv.indexOf("--deadline-ms");
  assert.ok(i !== -1 && argv[i + 1] === "3600000", "expected --deadline-ms 3600000 in companion argv");
});
