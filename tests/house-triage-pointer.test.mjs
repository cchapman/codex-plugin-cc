// house-triage-pointer.test.mjs — pins HOUSE(triage-pointer) in both review
// commands.
//
// Why this exists. Both /codex:review and /codex:adversarial-review are
// gate-creditable in the house config (routing.json gate_credit.review_skills,
// mirrored in ~/.claude/hooks/stop-gate.py). Invoking either satisfies the
// stop-gate review chime by NAME. Neither loads the house review contract, so
// their findings arrive without [PRECONDITION ...] tags and with no pointer to
// the house triage taxonomy — meaning a session could earn review credit while
// acting on findings untriaged, which is the unbounded fix loop house issue
// #111 exists to stop.
//
// The pointer is prose in a command file, so nothing but a test keeps it there:
// the same omission recurred four times on the house side before it was
// mechanized. ~/.claude/hooks/test-hooks.sh classifies these two commands as
// `external` and cannot check their content — this file is the other half of
// that check, on the side that owns the files.

import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMMANDS = path.join(ROOT, "plugins", "codex", "commands");

const REVIEW_COMMANDS = ["review.md", "adversarial-review.md"];

for (const name of REVIEW_COMMANDS) {
  test(`${name} carries the HOUSE triage pointer`, () => {
    const source = fs.readFileSync(path.join(COMMANDS, name), "utf8");

    // The marker itself — greppable, matching the HOUSE(...) convention used
    // for house deltas in codex-companion.mjs.
    assert.match(source, /HOUSE\(triage-pointer\)/,
      "missing HOUSE(triage-pointer) marker");

    // The pointer must name the canonical taxonomy by path AND step, so a
    // reader can find it without already knowing where it lives.
    assert.match(source, /~\/\.claude\/skills\/review-changes\/SKILL\.md/,
      "pointer does not name the canonical taxonomy file");
    assert.match(source, /Step 5/,
      "pointer does not name the canonical taxonomy step");

    // The two facts that make the pointer load-bearing rather than decorative:
    // that this dispatch credits the gate, and that findings arrive untagged.
    assert.match(source, /credits the house stop-gate/i,
      "pointer does not state that this dispatch credits the gate");
    assert.match(source, /PRECONDITION/,
      "pointer does not warn that findings arrive without precondition tags");

    // Traceability back to the issue that motivated it.
    assert.match(source, /#111/,
      "pointer does not reference house issue #111");
  });
}

test("the triage pointer does not weaken the review-only constraint", () => {
  // The pointer sits inside the Core constraint block; it must not be read as
  // permission to act on findings inside the command itself.
  for (const name of REVIEW_COMMANDS) {
    const source = fs.readFileSync(path.join(COMMANDS, name), "utf8");
    assert.match(source, /review-only/i);
    assert.match(source, /Do not fix issues/i);
    assert.match(source, /Do not fix any issues mentioned in the review output/i);
  }
});
