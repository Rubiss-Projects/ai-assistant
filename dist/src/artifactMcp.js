import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ARTIFACT_TOOLS } from "./common/artifactToolDefinitions.js";
const endpoint = process.env.AI_ARTIFACT_BRIDGE_URL;
const token = process.env.AI_ARTIFACT_BRIDGE_TOKEN;
if (!endpoint || !token) throw new Error("Artifact MCP must be started by the bot.");
const server = new Server({
    name: "ai-assistant-artifacts",
    version: "1.0.0"
}, {
    capabilities: {
        tools: {}
    }
});
const allowed = process.env.AI_ARTIFACT_ALLOWED_TOOLS ? JSON.parse(process.env.AI_ARTIFACT_ALLOWED_TOOLS) : undefined;
server.setRequestHandler(ListToolsRequestSchema, async ()=>({
        tools: ARTIFACT_TOOLS.filter((t)=>!allowed || allowed.includes(t.name))
    }));
server.setRequestHandler(CallToolRequestSchema, async (request)=>{
    try {
        if (allowed && !allowed.includes(request.params.name)) throw new Error('Tool unavailable for this transport.');
        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json"
            },
            body: JSON.stringify(request.params),
            signal: AbortSignal.timeout(950_000)
        });
        if (!response.ok) throw new Error("Artifact bridge is unavailable or this session has expired.");
        return await response.json();
    } catch (error) {
        return {
            isError: true,
            content: [
                {
                    type: "text",
                    text: error instanceof Error ? error.message : "Artifact call failed."
                }
            ]
        };
    }
});
await server.connect(new StdioServerTransport());
process.stdin.on("end", ()=>{
    void server.close();
});
