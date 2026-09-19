// Host-launched stdio adapter. Only the bot process owns Discord permissions and ruleset storage.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { RULESET_TOOLS } from "./common/rulesetToolDefinitions.js";
const endpoint = process.env.AI_RULESET_BRIDGE_URL;
const token = process.env.AI_RULESET_BRIDGE_TOKEN;
if (!endpoint || !token)
    throw new Error("Ruleset MCP must be started by the bot.");
const server = new Server({ name: "ai-assistant-rulesets", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: RULESET_TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
        const response = await fetch(endpoint, {
            method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify(request.params), signal: AbortSignal.timeout(115_000),
        });
        if (!response.ok)
            throw new Error("Ruleset bridge is unavailable or this session has expired.");
        return await response.json();
    }
    catch (error) {
        return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Ruleset call failed." }] };
    }
});
await server.connect(new StdioServerTransport());
process.stdin.on("end", () => { void server.close(); });
