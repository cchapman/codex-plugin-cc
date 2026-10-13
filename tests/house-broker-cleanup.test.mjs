import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeTempDir, run } from "./helpers.mjs";

const helpersUrl = new URL("./helpers.mjs", import.meta.url).href;
const lifecycleUrl = new URL("../plugins/codex/scripts/lib/broker-lifecycle.mjs", import.meta.url).href;

for (const fails of [false, true]) {
  test(`temporary workspace cleanup stops a saved process tree after a ${fails ? "failing" : "passing"} test`, async (t) => {
    const directory = makeTempDir();
    const record = path.join(directory, "session.json");
    const fixture = path.join(directory, "cleanup.test.mjs");
    const stopFile = path.join(directory, "stop");
    // Ask only this fixture's process to exit if the regression fails. Never
    // re-signal saved PIDs: successful cleanup may already have released them.
    t.after(() => fs.writeFileSync(stopFile, "stop"));
    // Exercise real detached processes and persisted session state. No socket is
    // needed: this pins the cleanup fallback as well as failure-path registration.
    fs.writeFileSync(fixture, `
      import test from "node:test";
      import fs from "node:fs";
      import path from "node:path";
      import { spawn } from "node:child_process";
      import { makeTempDir } from ${JSON.stringify(helpersUrl)};
      import { createBrokerSessionDir, saveBrokerSession } from ${JSON.stringify(lifecycleUrl)};
      test("workspace owner", async () => {
        const cwd = makeTempDir();
        const sessionDir = createBrokerSessionDir();
        const childRecord = path.join(cwd, "child.pid");
        const source = \`
          const { spawn } = require("node:child_process");
          const fs = require("node:fs");
          const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
          fs.writeFileSync(process.argv[1], String(child.pid));
          const timer = setInterval(() => {
            if (fs.existsSync(${JSON.stringify(stopFile)})) {
              clearInterval(timer);
              child.kill();
            }
          }, 20);
        \`;
        const broker = spawn(process.execPath, ["-e", source, childRecord], { detached: true, stdio: "ignore" });
        broker.unref();
        const session = { pid: broker.pid, sessionDir, pidFile: path.join(sessionDir, "broker.pid"), logFile: path.join(sessionDir, "broker.log") };
        fs.writeFileSync(session.pidFile, String(broker.pid));
        fs.writeFileSync(session.logFile, "");
        fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(session));
        saveBrokerSession(cwd, session);
        const deadline = Date.now() + 5000;
        while (!fs.existsSync(childRecord) && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        if (!fs.existsSync(childRecord)) throw new Error("child did not start");
        fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ ...session, childPid: Number(fs.readFileSync(childRecord, "utf8")) }));
        ${fails ? 'throw new Error("intentional owner failure");' : ''}
      });
    `);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = run(process.execPath, ["--test", fixture], { env });
    assert.ok(fs.existsSync(record), result.stdout + result.stderr);
    const session = JSON.parse(fs.readFileSync(record, "utf8"));
    assert.equal(result.status, fails ? 1 : 0, result.stdout + result.stderr);
    if (fails) assert.match(result.stdout, /intentional owner failure/);
    const alive = (pid) => {
      try { process.kill(pid, 0); return true; }
      catch (error) { if (error.code === "ESRCH") return false; throw error; }
    };
    const deadline = Date.now() + 5000;
    while ((alive(session.pid) || alive(session.childPid)) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(alive(session.pid), false, "saved broker process survived test cleanup");
    assert.equal(alive(session.childPid), false, "app-server child survived test cleanup");
    assert.equal(fs.existsSync(session.sessionDir), false, "broker artifacts survived test cleanup");
  });
}
