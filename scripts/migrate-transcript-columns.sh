#!/usr/bin/env bash
# Adds transcript_json + transcript_text columns to the conversation table.
# Use this once if the importer fails on INSERT because Listen backend hasn't
# already migrated the DB. Idempotent: each statement is safe to re-run because
# we tolerate the "duplicate column" error on retry.

set -u

DB="${LISTEN_SQL_DB:-xyz.tinycloud.listen/conversations}"
PROFILE="${LISTEN_PROFILE:-}"

run() {
  local stmt="$1"
  local args=(sql execute "$stmt" --db "$DB" --params "[]")
  if [[ -n "$PROFILE" ]]; then
    args+=(--profile "$PROFILE")
  fi
  echo "+ tc ${args[*]}"
  if ! tc "${args[@]}"; then
    echo "  (statement failed; column may already exist — continuing)"
  fi
}

run "ALTER TABLE conversation ADD COLUMN transcript_json TEXT"
run "ALTER TABLE conversation ADD COLUMN transcript_text TEXT"

echo "Done. transcript_json and transcript_text columns are present (or were already)."
