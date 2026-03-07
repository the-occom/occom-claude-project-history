#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { registerSessionTools } from "./tools/session.js";
import { registerWorkflowTools } from "./tools/workflows.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerBlockerTools } from "./tools/blockers.js";
import { registerDecisionTools } from "./tools/decisions.js";
import { getDb } from "./db.js";

const server = new McpServer({
  name: "occom-claude-project-history",
  version: "0.2.0"
});

// Register all tools
registerSessionTools(server);
registerWorkflowTools(server);
registerTaskTools(server);
registerBlockerTools(server);
registerDecisionTools(server);

const mode = process.argv[2];

async function main(): Promise<void> {
  // Pre-warm DB so first tool call isn't slow
  await getDb();

  if (mode === "--serve") {
    const app = express();
    const port = Number(process.env.CPH_PORT ?? 3741);

    const transports = new Map<string, SSEServerTransport>();

    app.get("/sse", async (_req, res) => {
      const transport = new SSEServerTransport("/message", res);
      transports.set(transport.sessionId, transport);
      res.on("close", () => transports.delete(transport.sessionId));
      await server.connect(transport);
    });

    app.post("/message", express.json(), async (req, res) => {
      const sessionId = req.query.sessionId as string;
      const transport = transports.get(sessionId);
      if (!transport) { res.status(404).end(); return; }
      await transport.handlePostMessage(req, res);
    });

    app.get("/health", (_req, res) => res.json({ status: "ok", pid: process.pid }));

    app.listen(port, "127.0.0.1", () => {
      console.error(`[cph] daemon ready on :${port}`);
    });
  } else {
    // Existing stdio path
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[cph] MCP server running. DB at ~/.cph/db");
  }
}

main().catch((error: unknown) => {
  console.error("[cph] Fatal error:", error);
  process.exit(1);
});
