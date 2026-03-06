#!/usr/bin/env bash
# FlowMind Tier 2 QA — Claude-Mediated E2E Test
#
# Invokes `claude -p` with --mcp-config to test the full Claude-mediated path.
# Each step issues a directive prompt forcing Claude to call a specific FlowMind tool.
#
# Run: bash scripts/test-e2e-claude.sh
set -uo pipefail

# Allow running from within a Claude Code session
unset CLAUDECODE 2>/dev/null || true
CLAUDE_CMD=(env -u CLAUDECODE claude)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_PATH="$PROJECT_DIR/dist/index.js"
DB_PATH="$HOME/.flowmind/db"
MCP_CONFIG="/tmp/flowmind-qa-mcp.json"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
REPORT="$PROJECT_DIR/qa-report-$TIMESTAMP.md"
BUDGET="0.50"

# Temp files
TMP_JSON="/tmp/flowmind-qa-json.json"
TMP_RAW="/tmp/flowmind-qa-raw.txt"

passed=0
failed=0
total_start=$(date +%s)

# ── Helpers ──────────────────────────────────────────────────────────────────

log() { echo ""; echo "── $1 $(printf '─%.0s' $(seq 1 $((60 - ${#1}))))"; }

check_field() {
  local path="$1" expected="$2" label="$3"
  local actual
  actual=$(jq -r "$path" "$TMP_JSON" 2>/dev/null) || actual="__jq_error__"
  if [ "$actual" = "$expected" ]; then
    echo "  PASS: $label ($path == $expected)"
    passed=$((passed + 1))
  else
    echo "  FAIL: $label ($path: expected '$expected', got '$actual')"
    failed=$((failed + 1))
  fi
}

check_exists() {
  local path="$1" label="$2"
  local val
  val=$(jq -r "$path" "$TMP_JSON" 2>/dev/null) || val="null"
  if [ "$val" != "null" ] && [ -n "$val" ]; then
    echo "  PASS: $label ($path exists)"
    passed=$((passed + 1))
  else
    echo "  FAIL: $label ($path is null/empty)"
    failed=$((failed + 1))
  fi
}

json_field() {
  jq -r "$1" "$TMP_JSON" 2>/dev/null
}

has_json() {
  [ -s "$TMP_JSON" ] && jq empty "$TMP_JSON" 2>/dev/null
}

# Call claude -p. Writes parsed JSON to TMP_JSON, raw text to TMP_RAW.
call_claude() {
  local prompt="$1"

  # Get raw text output from claude
  local raw_text
  raw_text=$("${CLAUDE_CMD[@]}" -p "$prompt" \
    --output-format text \
    --mcp-config "$MCP_CONFIG" \
    --dangerously-skip-permissions \
    --max-budget-usd "$BUDGET" 2>/dev/null) || raw_text=""

  echo "$raw_text" > "$TMP_RAW"

  # Extract first JSON object or array from the text
  python3 "$SCRIPT_DIR/extract-json.py" < "$TMP_RAW" > "$TMP_JSON" 2>/dev/null
}

report_line() {
  echo "$1" >> "$REPORT"
}

# ── Setup ────────────────────────────────────────────────────────────────────

log "Setup"

if [ -d "$DB_PATH" ]; then
  rm -rf "$DB_PATH"
  echo "  Cleaned $DB_PATH"
fi

if [ ! -f "$SERVER_PATH" ]; then
  echo "ERROR: $SERVER_PATH not found. Run 'npm run build' first."
  exit 1
fi

printf '{"mcpServers":{"flowmind":{"command":"node","args":["%s"]}}}' "$SERVER_PATH" > "$MCP_CONFIG"
echo "  MCP config: $MCP_CONFIG"
echo "  Report: $REPORT"

{
  echo "# FlowMind E2E QA Report"
  echo ""
  echo "**Date:** $(date -u +'%Y-%m-%d %H:%M:%S UTC')"
  echo "**Server:** $SERVER_PATH"
  echo ""
  echo "---"
  echo ""
  echo "## Steps"
  echo ""
} > "$REPORT"

# ── Step 1: Create Workflow ──────────────────────────────────────────────────

log "Step 1: flowmind_workflow_create"
call_claude 'Call the flowmind_workflow_create tool with name="QA Test Workflow" and description="E2E test". Return ONLY the raw JSON from the tool, nothing else.'

if has_json; then
  check_field ".status" "active" "Step 1: status"
  check_exists ".id" "Step 1: id exists"
  WORKFLOW_ID=$(json_field '.id')
  echo "  workflow_id = $WORKFLOW_ID"
else
  echo "  FAIL: Could not parse Step 1 output"
  failed=$((failed + 1))
  WORKFLOW_ID=""
fi

report_line "### Step 1: flowmind_workflow_create - $([ -n "$WORKFLOW_ID" ] && echo 'OK' || echo 'FAIL')"
report_line ""

if [ -z "$WORKFLOW_ID" ]; then
  echo "FATAL: No workflow_id. Cannot continue."
  report_line "**ABORTED:** No workflow_id extracted from Step 1."
  exit 1
fi

# ── Step 2: Create Task ─────────────────────────────────────────────────────

log "Step 2: flowmind_task_create"
call_claude "Call the flowmind_task_create tool with workflow_id=\"$WORKFLOW_ID\", title=\"Implement login\", priority=\"high\", estimated_minutes=30. Return ONLY the raw JSON."

if has_json; then
  check_field ".status" "pending" "Step 2: status"
  check_field ".priority" "high" "Step 2: priority"
  TASK_ID=$(json_field '.id')
  echo "  task_id = $TASK_ID"
else
  echo "  FAIL: Could not parse Step 2 output"
  failed=$((failed + 1))
  TASK_ID=""
fi

report_line "### Step 2: flowmind_task_create - $([ -n "$TASK_ID" ] && echo 'OK' || echo 'FAIL')"
report_line ""

if [ -z "$TASK_ID" ]; then
  echo "FATAL: No task_id. Cannot continue."
  exit 1
fi

# ── Step 3: Start Task ──────────────────────────────────────────────────────

log "Step 3: flowmind_task_start"
call_claude "Call the flowmind_task_start tool with task_id=\"$TASK_ID\". Return ONLY the raw JSON."

if has_json; then
  check_field ".status" "in_progress" "Step 3: status"
  check_exists ".started_at" "Step 3: started_at"
else
  echo "  FAIL: Could not parse Step 3 output"
  failed=$((failed + 1))
fi

report_line "### Step 3: flowmind_task_start"
report_line ""

# ── Step 4: Record Decision ─────────────────────────────────────────────────

log "Step 4: flowmind_decision_record"
call_claude "Call the flowmind_decision_record tool with workflow_id=\"$WORKFLOW_ID\", task_id=\"$TASK_ID\", title=\"Use bcrypt over argon2\", decision=\"Chose bcrypt for password hashing\", tags=\"auth,security\". Return ONLY the raw JSON."

if has_json; then
  check_exists ".id" "Step 4: id exists"
  check_field ".tags" "auth,security" "Step 4: tags"
  DECISION_ID=$(json_field '.id')
  echo "  decision_id = $DECISION_ID"
else
  echo "  FAIL: Could not parse Step 4 output"
  failed=$((failed + 1))
fi

report_line "### Step 4: flowmind_decision_record"
report_line ""

# ── Step 5: Create Blocker ──────────────────────────────────────────────────

log "Step 5: flowmind_blocker_create"
call_claude "Call the flowmind_blocker_create tool with workflow_id=\"$WORKFLOW_ID\", task_id=\"$TASK_ID\", title=\"Waiting for OAuth secrets\", blocker_type=\"waiting_on_human\". Return ONLY the raw JSON."

if has_json; then
  check_field ".status" "open" "Step 5: blocker status"
  BLOCKER_ID=$(json_field '.id')
  echo "  blocker_id = $BLOCKER_ID"
else
  echo "  FAIL: Could not parse Step 5 output"
  failed=$((failed + 1))
  BLOCKER_ID=""
fi

report_line "### Step 5: flowmind_blocker_create"
report_line ""

# Verify task was auto-blocked
echo "  Verifying task auto-blocked..."
call_claude "Call the flowmind_task_get tool with task_id=\"$TASK_ID\". Return ONLY the raw JSON."
if has_json; then
  check_field ".status" "blocked" "Step 5b: task auto-blocked"
fi

if [ -z "$BLOCKER_ID" ]; then
  echo "FATAL: No blocker_id. Cannot continue."
  exit 1
fi

# ── Step 6: Resolve Blocker ─────────────────────────────────────────────────

log "Step 6: flowmind_blocker_resolve"
call_claude "Call the flowmind_blocker_resolve tool with blocker_id=\"$BLOCKER_ID\", resolution=\"Secrets provided via 1Password\". Return ONLY the raw JSON."

if has_json; then
  check_field ".status" "resolved" "Step 6: blocker resolved"
else
  echo "  FAIL: Could not parse Step 6 output"
  failed=$((failed + 1))
fi

# Verify task auto-unblocked
echo "  Verifying task auto-unblocked..."
call_claude "Call the flowmind_task_get tool with task_id=\"$TASK_ID\". Return ONLY the raw JSON."
if has_json; then
  check_field ".status" "in_progress" "Step 6b: task auto-unblocked"
fi

report_line "### Step 6: flowmind_blocker_resolve"
report_line ""

# ── Step 7: Complete Task ───────────────────────────────────────────────────

log "Step 7: flowmind_task_complete"
call_claude "Call the flowmind_task_complete tool with task_id=\"$TASK_ID\", actual_minutes=45. Return ONLY the raw JSON."

if has_json; then
  check_field ".status" "completed" "Step 7: status"
  check_field ".actual_minutes" "45" "Step 7: actual_minutes"
else
  echo "  FAIL: Could not parse Step 7 output"
  failed=$((failed + 1))
fi

report_line "### Step 7: flowmind_task_complete"
report_line ""

# ── Step 8: Session Init ────────────────────────────────────────────────────

log "Step 8: flowmind_session_init"
call_claude "Call the flowmind_session_init tool with workflow_id=\"$WORKFLOW_ID\", depth=\"standard\". Return ONLY the raw JSON."

if has_json; then
  check_exists ".workflow" "Step 8: has workflow"
  check_exists ".session_hint" "Step 8: has session_hint"
else
  echo "  FAIL: Could not parse Step 8 output"
  failed=$((failed + 1))
fi

report_line "### Step 8: flowmind_session_init"
report_line ""

# ── Step 9: Decision Search ─────────────────────────────────────────────────

log "Step 9: flowmind_decision_search"
call_claude "Call the flowmind_decision_search tool with query=\"bcrypt\". Return ONLY the raw JSON."

if has_json; then
  step9_title=$(json_field '.[0].title // empty')
  if echo "$step9_title" | grep -qi "bcrypt"; then
    echo "  PASS: Step 9: result contains bcrypt"
    passed=$((passed + 1))
  else
    echo "  FAIL: Step 9: result title='$step9_title', expected bcrypt"
    failed=$((failed + 1))
  fi
else
  echo "  FAIL: Could not parse Step 9 output"
  failed=$((failed + 1))
fi

report_line "### Step 9: flowmind_decision_search"
report_line ""

# ── Step 10: Workflow Summary ────────────────────────────────────────────────

log "Step 10: flowmind_workflow_summary"
call_claude "Call the flowmind_workflow_summary tool with workflow_id=\"$WORKFLOW_ID\". Return ONLY the raw JSON."

if has_json; then
  check_field ".task_counts.completed" "1" "Step 10: completed tasks"
  check_field ".decision_count" "1" "Step 10: decision count"
else
  echo "  FAIL: Could not parse Step 10 output"
  failed=$((failed + 1))
fi

report_line "### Step 10: flowmind_workflow_summary"
report_line ""

# ── Negative Test 11: Complete pending task ──────────────────────────────────

log "Negative 11: task_complete on pending task"
call_claude "Call the flowmind_task_create tool with workflow_id=\"$WORKFLOW_ID\", title=\"Fresh pending task\". Return ONLY the raw JSON."
NEG_TASK_ID=$(json_field '.id')

if [ -n "$NEG_TASK_ID" ] && [ "$NEG_TASK_ID" != "null" ]; then
  call_claude "Call the flowmind_task_complete tool with task_id=\"$NEG_TASK_ID\", actual_minutes=10. Return ONLY the raw output including any errors."
  if grep -qi "task_start" "$TMP_RAW" 2>/dev/null; then
    echo "  PASS: Neg 11: mentions task_start"
    passed=$((passed + 1))
  else
    echo "  FAIL: Neg 11: raw output does not mention task_start"
    failed=$((failed + 1))
  fi
else
  echo "  FAIL: Could not create task for negative test"
  failed=$((failed + 1))
fi

report_line "### Negative 11: task_complete on pending"
report_line ""

# ── Negative Test 12: Start completed task ───────────────────────────────────

log "Negative 12: task_start on completed task"
call_claude "Call the flowmind_task_start tool with task_id=\"$TASK_ID\". Return ONLY the raw output including any errors."
if grep -qi "completed" "$TMP_RAW" 2>/dev/null; then
  echo "  PASS: Neg 12: mentions completed"
  passed=$((passed + 1))
else
  echo "  FAIL: Neg 12: raw output does not mention completed"
  failed=$((failed + 1))
fi

report_line "### Negative 12: task_start on completed"
report_line ""

# ── Summary ──────────────────────────────────────────────────────────────────

total_end=$(date +%s)
wall_time=$((total_end - total_start))

echo ""
echo "============================================================"
echo "Results: $passed passed, $failed failed"
echo "Wall time: ${wall_time}s"
echo "Report: $REPORT"

{
  echo "---"
  echo ""
  echo "## Summary"
  echo ""
  echo "| Metric | Value |"
  echo "|--------|-------|"
  echo "| Passed | $passed |"
  echo "| Failed | $failed |"
  echo "| Wall time | ${wall_time}s |"
  echo ""
} >> "$REPORT"

if [ "$failed" -gt 0 ]; then
  echo "**Status: SOME TESTS FAILED**" >> "$REPORT"
  echo ""
  echo "Some tests failed!"
  exit 1
else
  echo "**Status: ALL TESTS PASSED**" >> "$REPORT"
  echo ""
  echo "All Tier 2 tests passed!"
fi

rm -f "$TMP_JSON" "$TMP_RAW"
