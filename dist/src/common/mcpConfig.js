import fs from "fs";
import os from "os";
import path from "path";
export class McpConfigLoader {
    static GLOBAL_PATH = process.env.MCP_CONFIG_PATH ??
        path.join(os.homedir(), ".config", "Code", "User", "mcp.json");
    static load(workingDir) {
        const global = this.readFile(this.GLOBAL_PATH, "mcpServers");
        const workspace = workingDir
            ? this.readFile(path.join(workingDir, ".vscode", "mcp.json"), "servers")
            : {};
        const merged = { ...global, ...workspace };
        return this.resolveAndFilter(merged);
    }
    static readFile(filePath, key) {
        try {
            const raw = fs.readFileSync(filePath, "utf8");
            const parsed = JSON.parse(raw);
            const servers = parsed[key];
            if (servers && typeof servers === "object" && !Array.isArray(servers)) {
                return servers;
            }
        }
        catch {
            // Missing or malformed — silently skip
        }
        return {};
    }
    static resolveAndFilter(raw) {
        const result = {};
        for (const [name, cfg] of Object.entries(raw)) {
            try {
                const resolved = this.resolveInputs(JSON.stringify(cfg));
                if (resolved === null) {
                    console.warn(`[McpConfigLoader] Skipping "${name}": unresolved \${input:...} values`);
                    continue;
                }
                const server = JSON.parse(resolved);
                if (!Array.isArray(server["tools"]))
                    server["tools"] = ["*"];
                result[name] = server;
            }
            catch {
                console.warn(`[McpConfigLoader] Skipping "${name}": invalid config`);
            }
        }
        return result;
    }
    /** Returns null if any ${input:xxx} remain after env resolution. */
    static resolveInputs(json) {
        const resolved = json.replace(/\$\{input:([\w-]+)\}/g, (match, id) => {
            const envKey = "MCP_INPUT_" + id.toUpperCase().replace(/[^A-Z0-9]/g, "_");
            return process.env[envKey] ?? match;
        });
        return /\$\{input:[\w-]+\}/.test(resolved) ? null : resolved;
    }
    /** Returns per-server status including whether it was skipped. */
    static status(workingDir) {
        const globalRaw = this.readFile(this.GLOBAL_PATH, "mcpServers");
        const workspaceRaw = workingDir
            ? this.readFile(path.join(workingDir, ".vscode", "mcp.json"), "servers")
            : {};
        const merged = { ...globalRaw, ...workspaceRaw };
        return Object.keys(merged).map((name) => {
            const source = name in workspaceRaw ? "workspace" : "global";
            const resolved = this.resolveInputs(JSON.stringify(merged[name]));
            return { name, source, enabled: resolved !== null };
        });
    }
}
