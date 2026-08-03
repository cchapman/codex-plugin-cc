// review-shape.mjs — full-shape validation for structured adversarial reviews.
// Port of bin/codex-review.py valid_result: a real review has verdict + nonempty
// summary + findings[] (each an object) + next_steps[] (each a string). A
// malformed object with only a verdict must NOT pass (fail closed, spec F1-02).
export function reviewShapeError(r) {
  if (r === null || typeof r !== "object" || Array.isArray(r)) return "result is not an object";
  if (typeof r.verdict !== "string" || !r.verdict.trim()) return "missing/empty verdict";
  if (typeof r.summary !== "string" || !r.summary.trim()) return "missing/empty summary";
  if (!Array.isArray(r.findings)) return "findings is not an array";
  if (!r.findings.every((f) => f !== null && typeof f === "object" && !Array.isArray(f))) {
    return "findings contains a non-object entry";
  }
  if (!Array.isArray(r.next_steps)) return "next_steps is not an array";
  if (!r.next_steps.every((s) => typeof s === "string")) {
    return "next_steps contains a non-string entry";
  }
  return null;   // individual finding sub-fields stay optional (renderer tolerates)
}

export function isValidReviewShape(r) { return reviewShapeError(r) === null; }

// The persisted-exitStatus decision (spec F1-02): runTrackedJob persists
// "completed" purely from exitStatus === 0, so this value IS the fail-closed
// guarantee. Turn failure keeps its own status; a "successful" turn with a
// parse failure or incomplete shape becomes exit 1.
export function computeReviewExitStatus({ turnStatus, parseError, result }) {
  if (turnStatus !== 0) return turnStatus || 1;
  if (parseError) return 1;
  return reviewShapeError(result) === null ? 0 : 1;
}
