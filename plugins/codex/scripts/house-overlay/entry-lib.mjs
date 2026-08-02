// entry-lib.mjs — shared supervisor plumbing for review-entry/task-entry.
// The supervisor contract (spec CXR-001): stay alive until the exact job
// terminates; NEVER unref()+return. Exit-code mapping is fail-closed.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_COMPANION = path.join(SCRIPTS_DIR, "codex-companion.mjs");
const { resolveJobFile, readJobFile } = await import(path.join(SCRIPTS_DIR, "lib/state.mjs"));
import fs from "node:fs";

export class UsageError extends Error {}

export function parseEntryArgs(argv, { valueFlags = [], boolFlags = [], required = [] }) {
  const opts = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (boolFlags.includes(name)) { opts[name] = true; continue; }
      if (valueFlags.includes(name)) {
        i += 1;
        if (i >= argv.length) throw new UsageError(`--${name} needs a value`);
        opts[name] = argv[i];
        continue;
      }
      throw new UsageError(`unknown flag ${a}`);
    }
    positionals.push(a);
  }
  for (const name of required) {
    if (!(typeof opts[name] === "string" && opts[name].trim())) {
      throw new UsageError(`--${name} is required`);
    }
  }
  return { opts, positionals };
}

export async function readStdin() {
  if (process.stdin.isTTY) return "";
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

// Spawn the companion, await its exit, then validate the correlated terminal
// job state. Returns the supervisor exit code: 0 only when the child exited 0
// AND the job persisted terminal "completed"; everything else is 1.
export async function superviseCompanion({ companion, args, cwd, env, jobId }) {
  const child = spawn(process.execPath, [companion, ...args], {
    cwd, env, stdio: ["ignore", "inherit", "inherit"]
  });
  const { code, signal } = await new Promise((resolve) => {
    child.on("error", (err) => {
      process.stderr.write(`entry: cannot launch companion: ${err.message}\n`);
      resolve({ code: null, signal: null });
    });
    child.on("exit", (c, s) => resolve({ code: c, signal: s }));
  });
  if (signal) {
    process.stderr.write(`entry: companion died on signal ${signal} — fail closed.\n`);
    return 1;
  }
  if (code !== 0) {
    process.stderr.write(`entry: companion exited ${code ?? "spawn-failure"} — fail closed (never a benign skip).\n`);
    return 1;
  }
  let job = null;
  try {
    const file = resolveJobFile(cwd, jobId);
    if (fs.existsSync(file)) job = readJobFile(file);
  } catch (err) {
    process.stderr.write(`entry: cannot read job state: ${err.message}\n`);
  }
  if (!job || job.id !== jobId || job.status !== "completed") {
    process.stderr.write(
      `entry: companion exited 0 but job ${jobId} is ${job ? job.status : "missing"} — fail closed.\n`);
    return 1;
  }
  return 0;
}
