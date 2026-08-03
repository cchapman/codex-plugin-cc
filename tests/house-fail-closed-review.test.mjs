import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { reviewShapeError, isValidReviewShape } = await import(
  path.join(ROOT, "plugins/codex/scripts/house-overlay/review-shape.mjs"));

const good = { verdict: "approve", summary: "s", findings: [], next_steps: [] };
test("full shape passes", () => assert.equal(reviewShapeError(good), null));
for (const [name, bad] of Object.entries({
  verdict_only: { verdict: "ok" },
  empty_verdict: { ...good, verdict: "  " },
  empty_summary: { ...good, summary: "" },
  bad_finding: { ...good, findings: [1] },
  bad_steps: { ...good, next_steps: [{}] },
  not_object: "nope",
  nullish: null
})) {
  test(`rejects ${name}`, () => assert.notEqual(reviewShapeError(bad), null));
}
test("isValidReviewShape mirrors", () => {
  assert.ok(isValidReviewShape(good));
  assert.ok(!isValidReviewShape({ verdict: "ok" }));
});

const { computeReviewExitStatus } = await import(
  path.join(ROOT, "plugins/codex/scripts/house-overlay/review-shape.mjs"));
test("turn failure wins", () =>
  assert.notEqual(computeReviewExitStatus({ turnStatus: 1, parseError: null, result: good }), 0));
test("parseError fails closed", () =>
  assert.notEqual(computeReviewExitStatus({ turnStatus: 0, parseError: "bad json", result: null }), 0));
test("incomplete shape fails closed", () =>
  assert.notEqual(computeReviewExitStatus({ turnStatus: 0, parseError: null, result: { verdict: "ok" } }), 0));
test("valid review passes", () =>
  assert.equal(computeReviewExitStatus({ turnStatus: 0, parseError: null, result: good }), 0));

import fs from "node:fs";
test("executeReviewRun wires computeReviewExitStatus (HOUSE marker present)", () => {
  const src = fs.readFileSync(
    path.join(ROOT, "plugins/codex/scripts/codex-companion.mjs"), "utf8");
  assert.match(src, /HOUSE-BEGIN\(fail-closed-review\)/);
  assert.match(src, /computeReviewExitStatus/);
});
