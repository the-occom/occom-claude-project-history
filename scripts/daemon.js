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
import http from "http";

const __dirname = typeof import.meta.dirname !== "undefined"
  ? import.meta.dirname : dirname(fileURLToPath(import.meta.url));

const CPH_DIR = join(homedir(), ".cph");
const PID_FILE = join(CPH_DIR, "daemon.pid");
const PORT_FILE = join(CPH_DIR, "daemon.port");
const HEARTBEAT_FILE = join(CPH_DIR, "daemon.heartbeat");
const LOG_FILE = join(CPH_DIR, "daemon.log");
const SERVER_PATH = resolve(__dirname, "..", "dist", "index.js");
const DEFAULT_PORT = 3741;

mkdirSync(CPH_DIR, { recursive: true });

function isRunning(pid) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function isStale(pid) {
  try {
    const ts = parseInt(readFileSync(HEARTBEAT_FILE, "utf8").trim());
    if (Date.now() - ts > 120_000 && isRunning(pid)) return true;
  } catch {}
  return false;
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
  try { unlinkSync(HEARTBEAT_FILE); } catch {}
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

  // Wait for the server to be ready (health check with retries)
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const ok = await new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on("error", () => resolve(false));
      req.setTimeout(500, () => { req.destroy(); resolve(false); });
    });
    if (ok) {
      console.log(`Daemon started (PID ${child.pid}, port ${port})`);
      return;
    }
  }

  cleanState();
  throw new Error(`Daemon spawned but failed to respond on port ${port}. Check ${LOG_FILE}`);
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

  const debugPort = process.env.CPH_DEBUG_PORT || 3742;
  console.log(`Daemon: running`);
  console.log(`  PID:  ${pid}`);
  console.log(`  MCP  → http://localhost:${port}/sse`);
  console.log(`  UI   → http://localhost:${debugPort}`);
  console.log(`  Log:  ${LOG_FILE}`);
}

function getDaemonVersion(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
      let body = "";
      res.on("data", (c) => body += c);
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(2000, () => { req.destroy(); resolve(null); });
  });
}

async function ensure() {
  const pid = readPid();
  if (pid && isRunning(pid)) {
    // Check for stale heartbeat
    if (isStale(pid)) {
      console.log(`Daemon PID ${pid} is stale (heartbeat > 120s old) — restarting`);
      stop();
      await start();
      return;
    }

    // Check for version/schema mismatch
    const port = readPort();
    if (port) {
      try {
        const health = await getDaemonVersion(port);
        if (health) {
          const { SCHEMA_VERSION } = await import(
            resolve(__dirname, "..", "dist", "db.js")
          );
          if (health.schema_version !== undefined && health.schema_version !== SCHEMA_VERSION) {
            console.log(`Schema version mismatch (running: ${health.schema_version}, local: ${SCHEMA_VERSION}) — restarting`);
            stop();
            await start();
            return;
          }
        }
      } catch {}
    }

    // Already running, not stale, versions match — nothing to do
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
