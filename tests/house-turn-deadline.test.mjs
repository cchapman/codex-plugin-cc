import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { houseCaptureTurn } = await import(
  path.join(ROOT, "plugins/codex/scripts/lib/codex.mjs"));

function fakeClient() {
  return {
    notificationHandler: null,
    requests: [],
    setNotificationHandler(h) { this.notificationHandler = h; },
    request(method, params) { this.requests.push({ method, params }); return new Promise(() => {}); }
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("case 1: startRequest never resolves -> deadline rejects, onDeadline fires", async () => {
  const client = fakeClient();
  let marker = false;
  await assert.rejects(
    houseCaptureTurn(client, "th-1", () => new Promise(() => {}),
      { deadlineMs: 120, onDeadline: () => { marker = true; } }),
    /deadline/i);
  assert.ok(marker, "HOUSE deadline hook did not execute");
});

test("case 2: turn starts, completion never arrives -> interrupt sent with ids, then reject", async () => {
  const client = fakeClient();
  await assert.rejects(
    houseCaptureTurn(client, "th-2",
      () => Promise.resolve({ turn: { id: "turn-2", status: "inProgress" } }),
      { deadlineMs: 120 }),
    /deadline/i);
  const intr = client.requests.find((r) => r.method === "turn/interrupt");
  assert.ok(intr, "turn/interrupt was not sent");
  assert.deepEqual(intr.params, { threadId: "th-2", turnId: "turn-2" });
});

test("case 3: startRequest rejects early -> original error, timer cancelled, NO delayed interrupt, no unhandledRejection", async () => {
  const client = fakeClient();
  const unhandled = [];
  const onUR = (err) => unhandled.push(err);
  process.on("unhandledRejection", onUR);
  try {
    await assert.rejects(
      houseCaptureTurn(client, "th-3", () => Promise.reject(new Error("boom")),
        { deadlineMs: 100 }),
      /boom/);
    await sleep(250);   // past the deadline — a leaked timer would fire here
    assert.equal(client.requests.filter((r) => r.method === "turn/interrupt").length, 0,
      "stray interrupt after early rejection");
    assert.equal(unhandled.length, 0, `unhandled rejections: ${unhandled}`);
  } finally {
    process.removeListener("unhandledRejection", onUR);
  }
});

test("no deadlineMs -> behavior unchanged (completes when turn completes)", async () => {
  const client = fakeClient();
  const p = houseCaptureTurn(client, "th-4",
    () => Promise.resolve({ turn: { id: "t4", status: "completed" } }), {});
  const state = await p;                       // immediate completion path (codex.mjs:602-604)
  assert.equal(state.finalTurn.status, "completed");
});

test("diagnostics scalars update on notifications (HOUSE block executed)", async () => {
  const client = fakeClient();
  const p = houseCaptureTurn(client, "th-5",
    () => Promise.resolve({ turn: { id: "t5", status: "inProgress" } }),
    { deadlineMs: 5000 });
  await sleep(10);      // let turnId be recorded
  client.notificationHandler({ method: "item/started",
    params: { threadId: "th-5", turnId: "t5",
              item: { id: "i1", type: "commandExecution", command: "ls" } } });
  client.notificationHandler({ method: "turn/completed",
    params: { threadId: "th-5", turn: { id: "t5", status: "completed" } } });
  const state = await p;
  assert.equal(state.houseToolCallCount, 1);
  assert.ok(state.houseLastEventAt > 0);
});

test("tracked-job integration: deadline failure persists job status failed", async (t) => {
  const os = await import("node:os"); const fs = await import("node:fs");
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "house-deadline-state-"));
  process.env.CLAUDE_PLUGIN_DATA = stateDir;
  t.after(() => { delete process.env.CLAUDE_PLUGIN_DATA; });
  const { runTrackedJob } = await import(
    path.join(ROOT, "plugins/codex/scripts/lib/tracked-jobs.mjs"));
  const { writeJobFile, resolveJobFile, readJobFile, ensureStateDir } = await import(
    path.join(ROOT, "plugins/codex/scripts/lib/state.mjs"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "house-deadline-cwd-"));
  ensureStateDir(cwd);
  const job = { id: "review-deadline-int", workspaceRoot: cwd, title: "t", kind: "k" };
  await assert.rejects(runTrackedJob(job, () =>
    houseCaptureTurn(fakeClient(), "th-6", () => new Promise(() => {}), { deadlineMs: 100 })));
  const stored = readJobFile(resolveJobFile(cwd, job.id));
  assert.equal(stored.status, "failed");
  assert.match(stored.errorMessage, /deadline/i);
});
