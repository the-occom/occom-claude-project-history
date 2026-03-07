#!/usr/bin/env node
/**
 * CPH Daemon Manager
 *
 * Usage:
 *   node scripts/daemon.js start    — spawn detached daemon, write PID+port
 *   node scripts/daemon.js stop     — kill daemon, clean up state files
 *   node scripts/daemon.js status   — print running/stopped + port + uptime
 *   node scripts/daemon.js restart  — stop + start
 *   node scripts/daemon.js ensure   — start only if not already running
 */

import { spawn, execSync } from "child_process";
import { join, resolve, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import {
  writeFileSync, readFileSync, unlinkSync, existsSync, openSync, mkdirSync
} from "fs";
import { createConnection } from "net";

const __dirname = typeof import.meta.dirname !== "undefined"
  ? import.meta.dirname : dirname(fileURLToPath(import.meta.url));

const CPH_DIR = join(homedir(), ".cph");
const PID_FILE = join(CPH_DIR, "daemon.pid");
const PORT_FILE = join(CPH_DIR, "daemon.port");
const LOG_FILE = join(CPH_DIR, "daemon.log");
const SERVER_PATH = resolve(__dirname, "..", "dist", "index.js");
const DEFAULT_PORT = 3741;

mkdirSync(CPH_DIR, { recursive: true });

function isRunning(pid) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function readPid() {
  try { return parseInt(readFileSync(PID_FILE, "utf8").trim()); }
  catch { return null; }
}

function readPort() {
  try { return parseInt(readFileSync(PORT_FILE, "utf8").trim()); }
  catch { return null; }
}

function cleanState() {
  try { unlinkSync(PID_FILE); } catch {}
  try { unlinkSync(PORT_FILE); } catch {}
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const conn = createConnection({ port, host: "127.0.0.1" });
    conn.on("connect", () => { conn.destroy(); resolve(false); });
    conn.on("error", () => resolve(true));
  });
}

async function findFreePort() {
  for (let p = DEFAULT_PORT; p <= DEFAULT_PORT + 10; p++) {
    if (await isPortFree(p)) return p;
  }
  throw new Error(`No free port found in range ${DEFAULT_PORT}-${DEFAULT_PORT + 10}`);
}

async function start() {
  const existingPid = readPid();
  if (existingPid && isRunning(existingPid)) {
    const port = readPort();
    console.log(`Daemon already running (PID ${existingPid}, port ${port})`);
    return;
  }

  cleanState();
  const port = await findFreePort();

  const out = openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [SERVER_PATH, "--serve"], {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, CPH_PORT: String(port) }
  });
  child.unref();

  writeFileSync(PID_FILE, String(child.pid));
  writeFileSync(PORT_FILE, String(port));

  // Wait briefly for the server to bind
  await new Promise((r) => setTimeout(r, 500));

  console.log(`Daemon started (PID ${child.pid}, port ${port})`);
}

function stop() {
  const pid = readPid();
  if (!pid || !isRunning(pid)) {
    console.log("Daemon is not running");
    cleanState();
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    console.log(`Daemon stopped (PID ${pid})`);
  } catch (err) {
    console.error(`Failed to stop daemon: ${err.message}`);
  }
  cleanState();
}

function status() {
  const pid = readPid();
  const port = readPort();

  if (!pid || !isRunning(pid)) {
    console.log("Daemon: stopped");
    if (pid) cleanState();
    return;
  }

  console.log(`Daemon: running`);
  console.log(`  PID:  ${pid}`);
  console.log(`  Port: ${port}`);
  console.log(`  Log:  ${LOG_FILE}`);
}

async function ensure() {
  const pid = readPid();
  if (pid && isRunning(pid)) {
    // Already running — nothing to do
    return;
  }
  await start();
}

const command = process.argv[2];

switch (command) {
  case "start":   await start(); break;
  case "stop":    stop(); break;
  case "status":  status(); break;
  case "restart": stop(); await start(); break;
  case "ensure":  await ensure(); break;
  default:
    console.error("Usage: daemon.js <start|stop|status|restart|ensure>");
    process.exit(1);
}
