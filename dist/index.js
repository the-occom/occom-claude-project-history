#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerSessionTools } from "./tools/session.js";
import { registerWorkflowTools } from "./tools/workflows.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerBlockerTools } from "./tools/blockers.js";
import { registerDecisionTools } from "./tools/decisions.js";
import { getDb } from "./db.js";
const server = new McpServer({
    name: "occom-claude-project-history",
    version: "0.1.0"
});
// Register all tools
registerSessionTools(server);
registerWorkflowTools(server);
registerTaskTools(server);
registerBlockerTools(server);
registerDecisionTools(server);
async function main() {
    // Pre-warm DB so first tool call isn't slow
    await getDb();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // Log to stderr only — stdout is reserved for MCP protocol
    console.error("[cph] MCP server running. DB at ~/.cph/db");
}
main().catch((error) => {
    console.error("[cph] Fatal error:", error);
    process.exit(1);
});
//# sourceMappingURL=index.js.map