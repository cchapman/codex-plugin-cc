import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "plugins/codex/scripts/house-overlay/review-entry.mjs");
const FAKE = path.join(ROOT, "tests/fixtures/fake-companion.mjs");

const mkTmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
function gitRepo({ dirty = true } = {}) {
  const repo = mkTmp("house-entry-repo-");
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t",
    "commit", "--allow-empty", "-q", "-m", "init"]);
  if (dirty) fs.writeFileSync(path.join(repo, "f.txt"), "x\n");
  return repo;
}
function runEntry(repo, { mode = "ok", extraArgs = [], extraEnv = {}, jobId = "review-t1" } = {}) {
  return spawnSync(process.execPath,
    [ENTRY, "--job-id", jobId, "--cwd", repo, "--companion", FAKE, ...extraArgs],
    { input: "focus\n", encoding: "utf8", timeout: 60000,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: mkTmp("house-entry-state-"),
             FAKE_MODE: mode, ...extraEnv } });
}

test("healthy run: worker completes -> exit 0", () => {
  assert.equal(runEntry(gitRepo()).status, 0);
});
test("supervisor STAYS ALIVE to job termination (no unref+return)", () => {
  const t0 = Date.now();
  const r = runEntry(gitRepo(), { mode: "slow-ok" });
  assert.equal(r.status, 0);
  assert.ok(Date.now() - t0 >= 2000, "returned before the worker finished — launcher-that-returns");
});
test("worker fails -> exit 1", () => {
  assert.equal(runEntry(gitRepo(), { mode: "fail" }).status, 1);
});
test("child exit 3 is NOT the benign skip -> exit 1", () => {
  assert.equal(runEntry(gitRepo(), { mode: "exit3" }).status, 1);
});
test("clean child exit with NONTERMINAL job -> fail closed exit 1", () => {
  assert.equal(runEntry(gitRepo(), { mode: "early-exit" }).status, 1);
});
test("signal death -> exit 1", () => {
  assert.equal(runEntry(gitRepo(), { mode: "crash" }).status, 1);
});
test("empty diff -> exit 3 WITHOUT spawning the companion", () => {
  const marker = path.join(mkTmp("house-entry-marker-"), "spawned");
  const r = runEntry(gitRepo({ dirty: false }), { extraEnv: { FAKE_SPAWN_MARKER: marker } });
  assert.equal(r.status, 3);
  assert.ok(!fs.existsSync(marker), "companion was spawned on an empty diff");
});
test("missing --job-id -> usage exit 2", () => {
  const r = spawnSync(process.execPath, [ENTRY, "--cwd", gitRepo(), "--companion", FAKE],
    { input: "", encoding: "utf8", env: { ...process.env, FAKE_MODE: "ok" } });
  assert.equal(r.status, 2);
});
