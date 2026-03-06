#!/usr/bin/env node
/**
 * FlowMind Tier 1 QA — Raw MCP Protocol Test
 *
 * Spawns dist/index.js via StdioClientTransport, connects a real MCP Client,
 * and exercises 10 happy-path steps + 2 negative tests through JSON-RPC.
 *
 * Run: node scripts/test-mcp-raw.mjs
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import fs from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(__dirname, "..", "dist", "index.js");
const DB_PATH = resolve(process.env.HOME, ".flowmind", "db");

let passed = 0;
let failed = 0;
let currentStep = "";

function step(label) {
  currentStep = label;
  console.log(`\n── ${label} ${"─".repeat(Math.max(0, 60 - label.length))}`);
}

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label} [in ${currentStep}]`);
    failed++;
  }
}

async function callTool(client, toolName, args) {
  const result = await client.callTool({ name: toolName, arguments: args });
  const text = result.content?.[0]?.text ?? "";
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { parsed, text, isError: !!result.isError };
}

async function main() {
  console.log("FlowMind Tier 1 QA — Raw MCP Protocol Test\n");

  // ── Clean slate ──────────────────────────────────────────────────────────
  if (fs.existsSync(DB_PATH)) {
    fs.rmSync(DB_PATH, { recursive: true, force: true });
    console.log(`Cleaned ${DB_PATH}`);
  }

  // ── Connect ──────────────────────────────────────────────────────────────
  const transport = new StdioClientTransport({
    command: "node",
    args: [SERVER_PATH],
  });

  const client = new Client({
    name: "flowmind-qa",
    version: "1.0.0",
  });

  await client.connect(transport);
  console.log("Connected to FlowMind MCP server");

  // ── Verify tool count ────────────────────────────────────────────────────
  step("Tool Discovery");
  const { tools } = await client.listTools();
  const toolNames = tools.map((t) => t.name).sort();
  console.log(`  Found ${tools.length} tools: ${toolNames.join(", ")}`);
  assert(tools.length === 24, `Expected 24 tools, got ${tools.length}`);

  // ── Step 1: Create Workflow ──────────────────────────────────────────────
  step("Step 1: flowmind_workflow_create");
  const s1 = await callTool(client, "flowmind_workflow_create", {
    name: "QA Test Workflow",
    description: "Automated MCP protocol test",
  });
  assert(!s1.isError, "No error");
  assert(s1.parsed?.status === "active", `status === "active"`);
  assert(typeof s1.parsed?.id === "string" && s1.parsed.id.length > 0, "id exists");
  const workflow_id = s1.parsed?.id;
  console.log(`  workflow_id = ${workflow_id}`);

  // ── Step 2: Create Task ──────────────────────────────────────────────────
  step("Step 2: flowmind_task_create");
  const s2 = await callTool(client, "flowmind_task_create", {
    workflow_id,
    title: "Implement login",
    priority: "high",
    estimated_minutes: 30,
  });
  assert(!s2.isError, "No error");
  assert(s2.parsed?.status === "pending", `status === "pending"`);
  assert(s2.parsed?.priority === "high", `priority === "high"`);
  assert(s2.parsed?.estimated_minutes === 30, `estimated_minutes === 30`);
  const task_id = s2.parsed?.id;
  console.log(`  task_id = ${task_id}`);

  // ── Step 3: Start Task ───────────────────────────────────────────────────
  step("Step 3: flowmind_task_start");
  const s3 = await callTool(client, "flowmind_task_start", { task_id });
  assert(!s3.isError, "No error");
  assert(s3.parsed?.status === "in_progress", `status === "in_progress"`);
  assert(s3.parsed?.started_at != null, "started_at not null");

  // ── Step 4: Record Decision ──────────────────────────────────────────────
  step("Step 4: flowmind_decision_record");
  const s4 = await callTool(client, "flowmind_decision_record", {
    workflow_id,
    task_id,
    title: "Use bcrypt over argon2",
    decision: "Chose bcrypt for password hashing due to wider ecosystem support",
    rationale: "argon2 has better theoretical security but bcrypt is battle-tested",
    tags: "auth,security",
  });
  assert(!s4.isError, "No error");
  assert(typeof s4.parsed?.id === "string", "id exists");
  assert(s4.parsed?.tags === "auth,security", `tags === "auth,security"`);
  const decision_id = s4.parsed?.id;
  console.log(`  decision_id = ${decision_id}`);

  // ── Step 5: Create Blocker ───────────────────────────────────────────────
  step("Step 5: flowmind_blocker_create");
  const s5 = await callTool(client, "flowmind_blocker_create", {
    workflow_id,
    task_id,
    title: "Waiting for OAuth secrets",
    blocker_type: "waiting_on_human",
  });
  assert(!s5.isError, "No error");
  assert(s5.parsed?.status === "open", `blocker status === "open"`);
  const blocker_id = s5.parsed?.id;
  console.log(`  blocker_id = ${blocker_id}`);

  // Verify task auto-blocked
  const taskAfterBlock = await callTool(client, "flowmind_task_get", { task_id });
  assert(taskAfterBlock.parsed?.status === "blocked", "task auto-set to blocked");

  // ── Step 6: Resolve Blocker ──────────────────────────────────────────────
  step("Step 6: flowmind_blocker_resolve");
  const s6 = await callTool(client, "flowmind_blocker_resolve", {
    blocker_id,
    resolution: "Secrets provided via 1Password",
  });
  assert(!s6.isError, "No error");
  assert(s6.parsed?.status === "resolved", `blocker status === "resolved"`);

  // Verify task auto-unblocked
  const taskAfterUnblock = await callTool(client, "flowmind_task_get", { task_id });
  assert(taskAfterUnblock.parsed?.status === "in_progress", "task auto-set back to in_progress");

  // ── Step 7: Complete Task ────────────────────────────────────────────────
  step("Step 7: flowmind_task_complete");
  const s7 = await callTool(client, "flowmind_task_complete", {
    task_id,
    actual_minutes: 45,
  });
  assert(!s7.isError, "No error");
  assert(s7.parsed?.status === "completed", `status === "completed"`);
  assert(s7.parsed?.actual_minutes === 45, `actual_minutes === 45`);

  // ── Step 8: Session Init ─────────────────────────────────────────────────
  step("Step 8: flowmind_session_init");
  const s8 = await callTool(client, "flowmind_session_init", {
    workflow_id,
    depth: "standard",
  });
  assert(!s8.isError, "No error");
  assert(s8.parsed?.workflow != null, "has workflow");
  assert(Array.isArray(s8.parsed?.active_tasks), "has active_tasks array");
  assert(Array.isArray(s8.parsed?.recent_decisions), "has recent_decisions array");
  assert(s8.parsed?.recent_decisions?.length >= 1, "recent_decisions has >= 1 entry");
  assert(typeof s8.parsed?.session_hint === "string", "has session_hint");

  // ── Step 9: Decision Search ──────────────────────────────────────────────
  step("Step 9: flowmind_decision_search");
  const s9 = await callTool(client, "flowmind_decision_search", {
    query: "bcrypt",
  });
  assert(!s9.isError, "No error");
  assert(Array.isArray(s9.parsed), "returns array");
  assert(s9.parsed?.length >= 1, "at least 1 result");
  assert(
    s9.parsed?.some((d) => d.title?.includes("bcrypt")),
    'a result title contains "bcrypt"'
  );

  // ── Step 10: Workflow Summary ────────────────────────────────────────────
  step("Step 10: flowmind_workflow_summary");
  const s10 = await callTool(client, "flowmind_workflow_summary", {
    workflow_id,
  });
  assert(!s10.isError, "No error");
  assert(s10.parsed?.task_counts?.completed === 1, "task_counts.completed === 1");
  assert(s10.parsed?.decision_count === 1, "decision_count === 1");
  assert(
    s10.parsed?.estimation_accuracy === 1.5,
    `estimation_accuracy === 1.5 (got ${s10.parsed?.estimation_accuracy})`
  );

  // ── Negative Test 11: Complete a pending task ────────────────────────────
  step("Negative 11: task_complete on pending task");
  const freshTask = await callTool(client, "flowmind_task_create", {
    workflow_id,
    title: "Fresh pending task",
  });
  const n11 = await callTool(client, "flowmind_task_complete", {
    task_id: freshTask.parsed?.id,
    actual_minutes: 10,
  });
  assert(n11.isError === true, "isError is true");
  assert(
    typeof n11.text === "string" && n11.text.toLowerCase().includes("task_start"),
    'error message mentions "task_start"'
  );

  // ── Negative Test 12: Start a completed task ─────────────────────────────
  step("Negative 12: task_start on completed task");
  const n12 = await callTool(client, "flowmind_task_start", { task_id });
  assert(n12.isError === true, "isError is true");
  assert(
    typeof n12.text === "string" && n12.text.toLowerCase().includes("completed"),
    'error message mentions "completed"'
  );

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);

  await client.close();

  if (failed > 0) {
    console.error("\nSome tests failed!");
    process.exit(1);
  } else {
    console.log("\nAll Tier 1 tests passed!");
  }
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
