import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeTempDir, run } from "./helpers.mjs";

const helpersUrl = new URL("./helpers.mjs", import.meta.url).href;
const stateUrl = new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href;
const lifecycleUrl = new URL("../plugins/codex/scripts/lib/broker-lifecycle.mjs", import.meta.url).href;

const alive = (pid) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
};

for (const { fails, enclosingRepo } of [
  { fails: false, enclosingRepo: false },
  { fails: true, enclosingRepo: false },
  { fails: false, enclosingRepo: true }
]) {
  const name = enclosingRepo
    ? "temporary workspace cleanup preserves an enclosing repo's broker session"
    : `temporary workspace cleanup stops a saved process tree after a ${fails ? "failing" : "passing"} test`;
  test(name, async (t) => {
    const directory = makeTempDir();
    const record = path.join(directory, "session.json");
    const fixture = path.join(directory, "cleanup.test.mjs");
    const stopFile = path.join(directory, "stop");
    // Ask only this fixture's process to exit if the regression fails. Never
    // re-signal saved PIDs: successful cleanup may already have released them.
    let session;
    t.after(async () => {
      fs.writeFileSync(stopFile, "stop");
      if (!Number.isInteger(session?.childPid)) return;
      const deadline = Date.now() + 15000;
      while ((alive(session.pid) || alive(session.childPid)) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(alive(session.pid), false, "fake broker survived stop file");
      assert.equal(alive(session.childPid), false, "fake child survived stop file");
    });
    // Exercise real detached processes and persisted session state. No socket is
    // needed: this pins the cleanup fallback as well as failure-path registration.
    fs.writeFileSync(fixture, `
      import test from "node:test";
      import fs from "node:fs";
      import path from "node:path";
      import os from "node:os";
      import { spawn } from "node:child_process";
      import { initGitRepo, makeTempDir } from ${JSON.stringify(helpersUrl)};
      import { resolveStateDir } from ${JSON.stringify(stateUrl)};
      import { createBrokerSessionDir, saveBrokerSession } from ${JSON.stringify(lifecycleUrl)};
      test("workspace owner", async () => {
        // The enclosing repo has no cleanup hook: only its plain subdirectory
        // belongs to makeTempDir, so that hook must leave the repo's session alone.
        const cwd = ${enclosingRepo ? 'fs.mkdtempSync(path.join(os.tmpdir(), "enclosing-repo-"))' : 'makeTempDir()'};
        initGitRepo(cwd);
        ${enclosingRepo ? `
        const oldTmpdir = process.env.TMPDIR;
        process.env.TMPDIR = cwd;
        try {
          makeTempDir();
        } finally {
          if (oldTmpdir === undefined) delete process.env.TMPDIR;
          else process.env.TMPDIR = oldTmpdir;
        }
        ` : ''}
        const sessionDir = createBrokerSessionDir();
        const childRecord = path.join(cwd, "child.pid");
        const source = \`
          const { spawn } = require("node:child_process");
          const fs = require("node:fs");
          const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
          fs.writeFileSync(process.argv[1], String(child.pid));
          const stop = () => {
            clearInterval(timer);
            clearTimeout(lifetime);
            child.kill();
          };
          const timer = setInterval(() => {
            if (fs.existsSync(${JSON.stringify(stopFile)})) stop();
          }, 20);
          // Bound leaks even if the owner test runner is killed before teardown.
          const lifetime = setTimeout(stop, 30000);
        \`;
        const broker = spawn(process.execPath, ["-e", source, childRecord], { detached: true, stdio: "ignore" });
        broker.unref();
        const session = { pid: broker.pid, sessionDir, stateFile: path.join(resolveStateDir(cwd), "broker.json"), pidFile: path.join(sessionDir, "broker.pid"), logFile: path.join(sessionDir, "broker.log") };
        fs.writeFileSync(session.pidFile, String(broker.pid));
        fs.writeFileSync(session.logFile, "");
        fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(session));
        saveBrokerSession(cwd, session);
        const deadline = Date.now() + 15000;
        while (!fs.existsSync(childRecord) && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        if (!fs.existsSync(childRecord)) throw new Error("child did not start");
        fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ ...session, childPid: Number(fs.readFileSync(childRecord, "utf8")) }));
        ${fails ? 'throw new Error("intentional owner failure");' : ''}
      });
    `);
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: makeTempDir() };
    // Keep inherited Git overrides from redirecting fixture initialization.
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    delete env.NODE_TEST_CONTEXT;
    const result = run(process.execPath, ["--test", fixture], { env });
    assert.ok(fs.existsSync(record), result.stdout + result.stderr);
    session = JSON.parse(fs.readFileSync(record, "utf8"));
    assert.ok(Number.isInteger(session.childPid), result.stdout + result.stderr);
    assert.equal(result.status, fails ? 1 : 0, result.stdout + result.stderr);
    if (fails) assert.match(result.stdout, /intentional owner failure/);
    if (enclosingRepo) {
      assert.equal(alive(session.pid), true, "enclosing repo broker was stopped");
      assert.equal(alive(session.childPid), true, "enclosing repo child was stopped");
      assert.ok(fs.existsSync(session.stateFile), "enclosing repo session was deleted");
      assert.equal(JSON.parse(fs.readFileSync(session.stateFile, "utf8")).pid, session.pid);
      return;
    }
    const deadline = Date.now() + 15000;
    while ((alive(session.pid) || alive(session.childPid)) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(alive(session.pid), false, "saved broker process survived test cleanup");
    assert.equal(alive(session.childPid), false, "app-server child survived test cleanup");
    assert.equal(fs.existsSync(session.sessionDir), false, "broker artifacts survived test cleanup");
  });
}
