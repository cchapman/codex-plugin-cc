import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("house-overlay directory exists (created by Phase 1)", () => {
  assert.ok(
    fs.existsSync(path.join(ROOT, "plugins/codex/scripts/house-overlay")),
    "plugins/codex/scripts/house-overlay missing"
  );
});
