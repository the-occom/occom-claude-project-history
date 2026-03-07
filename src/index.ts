#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { registerSessionTools } from "./tools/session.js";
import { registerWorkflowTools } from "./tools/workflows.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerBlockerTools } from "./tools/blockers.js";
import { registerDecisionTools } from "./tools/decisions.js";
import { getDb } from "./db.js";
import { bus } from "./services/notify.js";
import { unregisterSession } from "./services/context.js";
import { createDebugRouter } from "./debug/router.js";

function createServer(sessionId: string = "stdio"): McpServer {
  const server = new McpServer({
    name: "occom-claude-project-history",
    version: "0.3.0"
  });

  registerSessionTools(server, sessionId);
  registerWorkflowTools(server);
  registerTaskTools(server);
  registerBlockerTools(server);
  registerDecisionTools(server);

  return server;
}

const mode = process.argv[2];

async function main(): Promise<void> {
  const db = await getDb();
  await bus.start(db);

  if (mode === "--serve") {
    const app = express();
    const port = Number(process.env.CPH_PORT ?? 3741);

    interface ActiveSession {
      server: McpServer;
      transport: SSEServerTransport;
    }

    const sessions = new Map<string, ActiveSession>();

    app.get("/sse", async (_req, res) => {
      const transport = new SSEServerTransport("/message", res);
      const server = createServer(transport.sessionId);
      sessions.set(transport.sessionId, { server, transport });
      res.on("close", () => {
        unregisterSession(transport.sessionId);
        sessions.delete(transport.sessionId);
      });
      await server.connect(transport);
    });

    app.post("/message", express.json(), async (req, res) => {
      const sessionId = req.query.sessionId as string;
      const session = sessions.get(sessionId);
      if (!session) { res.status(404).end(); return; }
      await session.transport.handlePostMessage(req, res);
    });

    app.get("/health", (_req, res) => res.json({ status: "ok", pid: process.pid }));

    app.listen(port, "127.0.0.1", () => {
      console.error(`[cph] daemon ready on :${port}`);
    });

    // Debug UI — separate port
    const debugPort = Number(process.env.CPH_DEBUG_PORT ?? 3742);
    const debugApp = express();
    debugApp.use(express.json());
    const __dirname = dirname(fileURLToPath(import.meta.url));
    debugApp.use(express.static(join(__dirname, "../debug")));
    debugApp.use("/api", createDebugRouter());
    debugApp.listen(debugPort, "127.0.0.1", () => {
      console.error(`[cph] debug UI → http://localhost:${debugPort}`);
    });
  } else {
    // Existing stdio path
    const server = createServer("stdio");
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[cph] MCP server running. DB at ~/.cph/db");
  }
}

main().catch((error: unknown) => {
  console.error("[cph] Fatal error:", error);
  process.exit(1);
});
