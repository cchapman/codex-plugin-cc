import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { writeJobFile, ensureStateDir } = await import(
  path.join(ROOT, "plugins/codex/scripts/lib/state.mjs")
);

const cwd = process.argv[process.argv.indexOf("--cwd") + 1];
const jobId = process.argv[process.argv.indexOf("--job-id") + 1];
const mode = process.env.FAKE_MODE ?? "ok";
if (process.env.FAKE_SPAWN_MARKER) fs.writeFileSync(process.env.FAKE_SPAWN_MARKER, "spawned\n");
if (process.env.FAKE_ENV_DUMP) {
  fs.writeFileSync(process.env.FAKE_ENV_DUMP,
    JSON.stringify({ GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? null,
                     GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? null }));
}
ensureStateDir(cwd);
const job = { id: jobId, workspaceRoot: cwd, title: "fake", kind: "fake" };
const finish = (status, code) => {
  writeJobFile(cwd, jobId, { ...job, status, completedAt: new Date().toISOString() });
  process.exit(code);
};
switch (mode) {
  case "ok":        finish("completed", 0); break;
  case "fail":      finish("failed", 1); break;
  case "exit3":     finish("failed", 3); break;                    // child 3 must map to 1
  case "early-exit": process.exit(0); break;                       // clean exit, NO terminal state
  case "crash":     process.kill(process.pid, "SIGKILL"); break;   // signal death
  case "slow-ok":   setTimeout(() => finish("completed", 0), 2000); break; // stays-alive case
  default:          process.exit(9);
}
