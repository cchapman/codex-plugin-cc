#!/usr/bin/env node
// task-entry.mjs — SUPERVISOR for a Codex task run (house fork). Mirrors
// review-entry.mjs; adds the --write worktree guard + Codex author-identity
// injection (provenance STAMP direction — spec CXR-003). Runs the companion
// task FOREGROUND (no --background): the supervisor process itself is the
// long-running envelope, and --resume-last therefore validates synchronously
// (the shim's async-enqueue preflight has no async enqueue left to guard).
import process from "node:process";
import {
  DEFAULT_COMPANION, UsageError, parseEntryArgs, readStdin, superviseCompanion
} from "./entry-lib.mjs";
import { writeGuard, formatUnsafeBanner } from "./worktree-guard.mjs";

const TASK_DEADLINE_DEFAULT_MS = 3_600_000; // 60 min — generous but NEVER infinite

async function main() {
  let opts;
  try {
    ({ opts } = parseEntryArgs(process.argv.slice(2), {
      valueFlags: ["job-id", "cwd", "model", "effort", "deadline-ms", "companion"],
      boolFlags: ["write", "unsafe-shared-checkout", "resume-last"],
      required: ["job-id", "cwd"]
    }));
  } catch (err) {
    if (err instanceof UsageError) { process.stderr.write(`task-entry: ${err.message}\n`); process.exit(2); }
    throw err;
  }
  const repo = opts.cwd;
  const jobId = opts["job-id"].trim();
  const deadlineMs = Number(opts["deadline-ms"] ?? process.env.TASK_DEADLINE_MS ?? TASK_DEADLINE_DEFAULT_MS);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    process.stderr.write("task-entry: invalid --deadline-ms\n"); process.exit(2);
  }
  const prompt = (await readStdin()).trim();
  if (!prompt && !opts["resume-last"]) {
    process.stderr.write("task-entry: empty prompt (stdin) and no --resume-last\n");
    process.exit(2);
  }
  const env = { ...process.env };
  if (opts.write) {
    const reason = await writeGuard(repo, Boolean(opts["unsafe-shared-checkout"]));
    if (reason) {
      process.stderr.write(`task-entry: write dispatch blocked: ${reason}\n`);
      process.exit(2);
    }
    if (opts["unsafe-shared-checkout"]) process.stdout.write(formatUnsafeBanner(repo));
    env.GIT_AUTHOR_NAME = "Codex (gpt-5.6)";
    env.GIT_AUTHOR_EMAIL = "codex@openai.local";
  }
  const args = ["task", "--json", "--cwd", repo, "--job-id", jobId,
    "--deadline-ms", String(deadlineMs)];
  if (opts.write) args.push("--write");
  if (opts["resume-last"]) args.push("--resume-last");
  if (opts.model) args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);
  if (prompt) args.push(prompt);
  process.exit(await superviseCompanion({
    companion: opts.companion ?? DEFAULT_COMPANION, args, cwd: repo, env, jobId
  }));
}

main().catch((err) => { process.stderr.write(`task-entry: ${err.message}\n`); process.exit(1); });
