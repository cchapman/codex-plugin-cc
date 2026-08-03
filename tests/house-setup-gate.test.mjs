import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPANION = path.join(ROOT, "plugins/codex/scripts/codex-companion.mjs");

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function gitRepo() {
  const repo = mkTmp("house-setupgate-repo-");
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t",
    "commit", "--allow-empty", "-q", "-m", "init"]);
  return repo;
}

function runSetup(repo, stateDir, extraArgs) {
  const res = spawnSync(process.execPath, [COMPANION, "setup", "--json",
    "--cwd", repo, ...extraArgs], {
    cwd: repo,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: stateDir, PATH: "/usr/bin:/bin" },
    encoding: "utf8", timeout: 60000
  });
  assert.equal(res.status, 0, `setup exited ${res.status}: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

// HOUSE(setup-gate-warning): enabling the gate must carry the deterministic
// house-policy warning in actionsTaken (the flag duplicates the external
// stop-gate flow), and the gate-off report must NOT upsell enabling it.

test("setup --enable-review-gate emits the house-policy warning", () => {
  const repo = gitRepo();
  const stateDir = mkTmp("house-setupgate-state-");
  const report = runSetup(repo, stateDir, ["--enable-review-gate"]);
  assert.equal(report.reviewGateEnabled, true);
  assert.ok(
    report.actionsTaken.some((a) => a.includes("WARNING (house policy)")),
    `actionsTaken missing house warning: ${JSON.stringify(report.actionsTaken)}`
  );
  assert.ok(
    report.actionsTaken.some((a) => a.includes("--disable-review-gate")),
    "warning must name the revert command"
  );
});

test("gate-off setup report carries the keep-it-off note, not upstream's upsell", () => {
  const repo = gitRepo();
  const stateDir = mkTmp("house-setupgate-state-");
  const report = runSetup(repo, stateDir, []);
  assert.equal(report.reviewGateEnabled, false);
  assert.ok(
    report.nextSteps.some((s) => s.includes("house policy: keep it off")),
    `nextSteps missing house note: ${JSON.stringify(report.nextSteps)}`
  );
  assert.ok(
    !report.nextSteps.some((s) => s.includes("run `/codex:setup --enable-review-gate`")),
    "upstream enable-gate upsell must be replaced"
  );
});

test("disable after enable clears the gate without further warnings", () => {
  const repo = gitRepo();
  const stateDir = mkTmp("house-setupgate-state-");
  runSetup(repo, stateDir, ["--enable-review-gate"]);
  const report = runSetup(repo, stateDir, ["--disable-review-gate"]);
  assert.equal(report.reviewGateEnabled, false);
  assert.ok(
    !report.actionsTaken.some((a) => a.includes("WARNING (house policy)")),
    "disable path must not warn"
  );
});
