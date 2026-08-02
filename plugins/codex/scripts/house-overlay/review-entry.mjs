#!/usr/bin/env node
// review-entry.mjs — SUPERVISOR for a Codex adversarial review (house fork).
// Launched by skills/codex-review as a harness background task; stays alive to
// job termination so the harness completion notification means REAL completion.
// Exit: 0 success / 3 empty diff (this pre-check only) / 1 fail-closed / 2 usage.
import { execFileSync } from "node:child_process";
import process from "node:process";
import {
  DEFAULT_COMPANION, UsageError, parseEntryArgs, readStdin, superviseCompanion
} from "./entry-lib.mjs";

const REVIEW_DEADLINE_DEFAULT_MS = 1_200_000; // 20 min (spec decision 5)

function diffIsEmpty(repo, base) {
  try {
    if (base) {
      try {
        execFileSync("git", ["-C", repo, "diff", "--quiet", `${base}...HEAD`], { timeout: 60000 });
        return true;             // exit 0 => no diff
      } catch (err) {
        if (err.status === 1) return false;  // differences exist
        throw err;               // bad ref etc. — fall through to fail-open-for-review
      }
    }
    const out = execFileSync("git", ["-C", repo, "status", "--porcelain"],
      { encoding: "utf8", timeout: 60000 });
    return !out.trim();
  } catch {
    return false;                // can't tell -> don't suppress the review
  }
}

async function main() {
  let opts;
  try {
    ({ opts } = parseEntryArgs(process.argv.slice(2), {
      valueFlags: ["job-id", "cwd", "base", "deadline-ms", "companion"],
      required: ["job-id", "cwd"]
    }));
  } catch (err) {
    if (err instanceof UsageError) { process.stderr.write(`review-entry: ${err.message}\n`); process.exit(2); }
    throw err;
  }
  const repo = opts.cwd;
  const jobId = opts["job-id"].trim();
  const deadlineMs = Number(opts["deadline-ms"] ?? process.env.REVIEW_TURN_DEADLINE_MS ?? REVIEW_DEADLINE_DEFAULT_MS);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    process.stderr.write("review-entry: invalid --deadline-ms\n"); process.exit(2);
  }
  if (diffIsEmpty(repo, opts.base)) {
    process.stdout.write("No changes to review (empty diff).\n");
    process.exit(3);
  }
  const focus = (await readStdin()).trim();
  const scope = opts.base ? "branch" : "working-tree";
  const args = ["adversarial-review", "--json", "--scope", scope,
    "--cwd", repo, "--job-id", jobId, "--deadline-ms", String(deadlineMs)];
  if (opts.base) args.push("--base", opts.base);
  if (focus) args.push(focus);
  process.exit(await superviseCompanion({
    companion: opts.companion ?? DEFAULT_COMPANION, args, cwd: repo, env: process.env, jobId
  }));
}

main().catch((err) => { process.stderr.write(`review-entry: ${err.message}\n`); process.exit(1); });
