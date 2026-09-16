import { ARTIFACT_TOOLS } from "./artifactToolDefinitions.js";
import { RULESET_TOOLS } from "./rulesetToolDefinitions.js";
import type { ArtifactMcpConfig } from "./artifactToolBridge.js";
import type { RulesetMcpConfig } from "./rulesetToolBridge.js";

function localServerToml(
  config: { command: string; args: string[]; env: Record<string, string> },
  tools: readonly { name: string }[],
  timeoutSec: number,
): string {
  const env = Object.entries(config.env).map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(",");
  const toolConfig = tools.map(({ name }) => `${JSON.stringify(name)}={approval_mode="approve"}`).join(",");
  return `{command=${JSON.stringify(config.command)},args=${JSON.stringify(config.args)},env={${env}},tools={${toolConfig}},startup_timeout_sec=60,tool_timeout_sec=${timeoutSec}}`;
}

export function codexHostMcpOverride(artifacts?: ArtifactMcpConfig, rulesets?: RulesetMcpConfig): string {
  if (!artifacts && !rulesets) return "mcp_servers={}";
  const servers: string[] = [];
  if (artifacts) servers.push(`artifact_tools=${localServerToml(artifacts, ARTIFACT_TOOLS, 960)}`);
  if (rulesets) servers.push(`ruleset_tools=${localServerToml(rulesets, RULESET_TOOLS, 120)}`);
  return `mcp_servers={${servers.join(",")}}`;
}

export function codexHostMcpOverrides(artifacts?: ArtifactMcpConfig, rulesets?: RulesetMcpConfig, replaceAll = true): string[] {
  if (replaceAll) return [codexHostMcpOverride(artifacts, rulesets)];
  const overrides: string[] = [];
  if (artifacts) overrides.push(`mcp_servers.artifact_tools=${localServerToml(artifacts, ARTIFACT_TOOLS, 960)}`);
  if (rulesets) overrides.push(`mcp_servers.ruleset_tools=${localServerToml(rulesets, RULESET_TOOLS, 120)}`);
  return overrides;
}
