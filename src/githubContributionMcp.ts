// This adapter receives only a session bridge credential, never a GitHub App key or token.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { GITHUB_CONTRIBUTION_TOOLS } from "./common/githubContributionToolDefinitions.js";

const endpoint = process.env.AI_GITHUB_BRIDGE_URL;
const token = process.env.AI_GITHUB_BRIDGE_TOKEN;
if (!endpoint || !token) throw new Error("GitHub contribution MCP must be started by the bot.");
const server = new Server({ name: "ai-assistant-github-contributions", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: GITHUB_CONTRIBUTION_TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  try {
    const response = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(request.params), signal: AbortSignal.timeout(115_000) });
    if (!response.ok) throw new Error("Contribution bridge is unavailable or the session has expired.");
    return await response.json();
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Contribution failed." }] };
  }
});
await server.connect(new StdioServerTransport());
process.stdin.on("end", () => { void server.close(); });
