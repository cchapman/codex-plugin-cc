import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs } from "../plugins/codex/scripts/lib/args.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPANION = path.join(ROOT, "plugins/codex/scripts/codex-companion.mjs");

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function gitRepo() {
  const repo = mkTmp("house-deadline-repo-");
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t",
    "commit", "--allow-empty", "-q", "-m", "init"]);
  return repo;
}

// Unit-level: pin the arg-parse seam. runAppServerTurn needs a live app-server
// and is not unit-testable end to end, so this pins the one thing that IS a
// pure function: --deadline-ms must be consumed as a value option, not spill
// into positionals (which become review focus text / task prompt text).
test("parseArgs consumes --deadline-ms as a value option, not a positional", () => {
  const { options, positionals } = parseArgs(
    ["--job-id", "x", "--deadline-ms", "60000", "--json"],
    {
      valueOptions: ["job-id", "deadline-ms"],
      booleanOptions: ["json"]
    }
  );
  assert.equal(options["deadline-ms"], "60000");
  assert.deepEqual(positionals, []);
});

test("parseArgs without deadline-ms registered leaks it into positionals (documents the failure mode)", () => {
  const { options, positionals } = parseArgs(
    ["--job-id", "x", "--deadline-ms", "60000", "--json"],
    {
      valueOptions: ["job-id"],
      booleanOptions: ["json"]
    }
  );
  assert.equal(options["deadline-ms"], undefined);
  assert.deepEqual(positionals, ["--deadline-ms", "60000"]);
});

// Integration: spawn the real companion (same fast-fail pattern as
// tests/house-job-id.test.mjs — PATH stripped of codex so getCodexAvailability
// fails and the run throws fast). The `task` command builds job.summary from
// the prompt (positionals) BEFORE executeTaskRun's ensureCodexAvailable() check
// fires, so a leaked --deadline-ms is observable in the persisted job record
// even though the run never reaches Codex.
test("task --deadline-ms is consumed as an OPTION, not leaked into the prompt", () => {
  const repo = gitRepo();
  const stateDir = mkTmp("house-deadline-state-");
  const jobId = "task-house-deadline-test";
  spawnSync(process.execPath, [COMPANION, "task", "--job-id", jobId,
    "--deadline-ms", "60000", "--json", "--cwd", repo], {
    cwd: repo,
    input: "",
    env: { ...process.env, CLAUDE_PLUGIN_DATA: stateDir, PATH: "/usr/bin:/bin" },
    encoding: "utf8", timeout: 60000
  });
  const stateRoot = path.join(stateDir, "state");
  const jobFiles = fs.readdirSync(stateRoot, { recursive: true })
    .filter((f) => String(f).endsWith(`${jobId}.json`));
  assert.equal(jobFiles.length, 1, `expected exactly one job file for ${jobId}`);
  const record = JSON.parse(fs.readFileSync(path.join(stateRoot, String(jobFiles[0])), "utf8"));
  assert.equal(record.id, jobId);
  assert.ok(
    !String(record.summary ?? "").includes("60000"),
    `--deadline-ms leaked into the task prompt/summary: ${record.summary}`
  );
});
