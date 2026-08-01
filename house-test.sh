#!/usr/bin/env bash
# house-test.sh — run the plugin test suite HERMETICALLY on house machines.
# A live Claude Code session exports CLAUDE_PLUGIN_DATA / CODEX_COMPANION_*,
# which upstream's state/status/result tests honor (state-dir hijack + session
# filtering), and the house global git ignore (~/.config/git/ignore) hides
# .claude/worktrees/ fixtures from git-status-based tests. Scrub both.
set -euo pipefail
cd "$(dirname "$0")"
XDG_TMP="$(mktemp -d "${TMPDIR:-/tmp}/house-test-xdg.XXXXXX")"
trap 'rm -rf "$XDG_TMP"' EXIT
env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID -u CODEX_COMPANION_TRANSCRIPT_PATH \
  XDG_CONFIG_HOME="$XDG_TMP" npm test "$@"
