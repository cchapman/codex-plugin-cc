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
  const repo = mkTmp("house-jobid-repo-");
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t",
    "commit", "--allow-empty", "-q", "-m", "init"]);
  fs.writeFileSync(path.join(repo, "f.txt"), "dirty\n"); // non-empty diff
  return repo;
}

test("adversarial-review --job-id is used for the persisted job file", () => {
  const repo = gitRepo();
  const stateDir = mkTmp("house-jobid-state-");
  const jobId = "review-house-jobid-test";
  // PATH stripped of codex => getCodexAvailability fails => runner throws fast;
  // the job record must STILL exist under OUR id with status "failed".
  spawnSync(process.execPath, [COMPANION, "adversarial-review", "--job-id", jobId,
    "--json", "--cwd", repo, "focus text"], {
    cwd: repo,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: stateDir, PATH: "/usr/bin:/bin" },
    encoding: "utf8", timeout: 60000
  });
  const stateRoot = path.join(stateDir, "state");
  const jobFiles = fs.readdirSync(stateRoot, { recursive: true })
    .filter((f) => String(f).endsWith(`${jobId}.json`));
  assert.equal(jobFiles.length, 1, `expected exactly one job file for ${jobId}`);
  const record = JSON.parse(fs.readFileSync(path.join(stateRoot, String(jobFiles[0])), "utf8"));
  assert.equal(record.id, jobId);
  assert.notEqual(record.status, "completed");
});
