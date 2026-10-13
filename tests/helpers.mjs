import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { after } from "node:test";
import { clearBrokerSession, loadBrokerSession, teardownBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";
import { resolveWorkspaceRoot } from "../plugins/codex/scripts/lib/workspace.mjs";

export function makeTempDir(prefix = "codex-plugin-test-") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // Register before returning so failed assertions cannot bypass teardown.
  // Only consult a session when the fixture is its own canonical workspace root;
  // an enclosing repo or inherited Git environment must not donate its broker.
  after(() => {
    try {
      if (fs.realpathSync.native(resolveWorkspaceRoot(directory)) !== fs.realpathSync.native(directory)) return;
    } catch {
      return;
    }
    const session = loadBrokerSession(directory);
    // Some status tests save endpoint-only stubs; those own no process.
    if (!Number.isInteger(session?.pid) || session.pid <= 0) return;
    clearBrokerSession(directory);
    // SIGTERM also invokes the real broker's shutdown handler. Terminate once,
    // rather than sending shutdown and then signaling a potentially exited PID.
    teardownBrokerSession({ ...session, killProcess: terminateProcessTree });
  });
  return directory;
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    shell: options.shell ?? (process.platform === "win32" && !path.isAbsolute(command)),
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}
