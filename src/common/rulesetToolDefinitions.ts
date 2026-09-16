const runProperty = { type: "string", description: "The current run_id from the ruleset-tool instructions." };
const userProperty = { type: "string", description: "Target Discord user ID or mention." };
const nameProperty = { type: "string", description: "Ruleset name. Use lowercase letters, numbers, dashes, or underscores." };
const instructionsProperty = { type: "string", description: "Ruleset instructions to apply to the target user." };

export const RULESET_TOOLS = [
  {
    name: "list_user_rulesets",
    description: "List rulesets for a Discord user in the current server. Use include_disabled=true to include disabled rulesets.",
    inputSchema: { type: "object" as const, properties: { run_id: runProperty, user: userProperty, include_disabled: { type: "string", enum: ["true", "false"] } }, required: ["run_id", "user"], additionalProperties: false },
  },
  {
    name: "get_user_ruleset",
    description: "Get one named ruleset for a Discord user in the current server.",
    inputSchema: { type: "object" as const, properties: { run_id: runProperty, user: userProperty, name: nameProperty }, required: ["run_id", "user", "name"], additionalProperties: false },
  },
  {
    name: "set_user_ruleset",
    description: "Create or replace a ruleset for a Discord user. Use this when an admin asks you to add or update a user-specific rule.",
    inputSchema: { type: "object" as const, properties: { run_id: runProperty, user: userProperty, name: nameProperty, instructions: instructionsProperty, priority: { type: "string" } }, required: ["run_id", "user", "instructions"], additionalProperties: false },
  },
  {
    name: "append_user_ruleset",
    description: "Append instructions to an existing ruleset for a Discord user.",
    inputSchema: { type: "object" as const, properties: { run_id: runProperty, user: userProperty, name: nameProperty, instructions: instructionsProperty }, required: ["run_id", "user", "name", "instructions"], additionalProperties: false },
  },
  {
    name: "delete_user_ruleset",
    description: "Delete one named ruleset for a Discord user.",
    inputSchema: { type: "object" as const, properties: { run_id: runProperty, user: userProperty, name: nameProperty }, required: ["run_id", "user", "name"], additionalProperties: false },
  },
  {
    name: "clear_user_rulesets",
    description: "Delete all rulesets for a Discord user in the current server.",
    inputSchema: { type: "object" as const, properties: { run_id: runProperty, user: userProperty }, required: ["run_id", "user"], additionalProperties: false },
  },
  {
    name: "enable_user_ruleset",
    description: "Enable one named ruleset for a Discord user.",
    inputSchema: { type: "object" as const, properties: { run_id: runProperty, user: userProperty, name: nameProperty }, required: ["run_id", "user", "name"], additionalProperties: false },
  },
  {
    name: "disable_user_ruleset",
    description: "Disable one named ruleset for a Discord user without deleting it.",
    inputSchema: { type: "object" as const, properties: { run_id: runProperty, user: userProperty, name: nameProperty }, required: ["run_id", "user", "name"], additionalProperties: false },
  },
  {
    name: "preview_user_rulesets",
    description: "Preview the exact instruction block that will be injected for a Discord user.",
    inputSchema: { type: "object" as const, properties: { run_id: runProperty, user: userProperty, include_disabled: { type: "string", enum: ["true", "false"] } }, required: ["run_id", "user"], additionalProperties: false },
  },
];
