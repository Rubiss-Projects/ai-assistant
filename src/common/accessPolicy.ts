import fs from "node:fs";

export const CAPABILITIES = [
  "chat.use", "session.configure", "workspace.manage", "mcp.manage", "bot.manage",
  "schedule.message.create", "schedule.ai.create", "schedule.manage.own", "schedule.manage.guild",
] as const;
export type Capability = typeof CAPABILITIES[number];
export interface AccessSubject { userId: string; guildId?: string | null; roleIds?: readonly string[] }
export interface AccessResource { guildId?: string | null; ownerId?: string }
const PRESETS = {
  member: ["chat.use"],
  scheduler: ["chat.use", "schedule.message.create", "schedule.manage.own"],
  "server-admin": ["chat.use", "schedule.message.create", "schedule.manage.own", "schedule.manage.guild"],
  "bot-admin": [...CAPABILITIES],
} satisfies Record<string, Capability[]>;
interface Grant { userId?: string; roleId?: string; guildId?: string; roles?: (keyof typeof PRESETS)[]; capabilities?: Capability[] }
function ids(value?: string): Set<string> { return new Set((value ?? "").split(",").map(x => x.trim()).filter(Boolean)); }

export function parseGrants(value: unknown): Grant[] {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(k => k !== "grants") || !Array.isArray((value as { grants?: unknown }).grants)) {
    throw new Error("Rights configuration must contain a grants array.");
  }
  return (value as { grants: unknown[] }).grants.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid rights grant.");
    const grant = raw as Grant;
    if (Object.keys(grant).some(k => !["userId", "roleId", "guildId", "roles", "capabilities"].includes(k))
      || Boolean(grant.userId) === Boolean(grant.roleId)
      || [grant.userId, grant.roleId, grant.guildId].some(id => id !== undefined && (typeof id !== "string" || !/^\d+$/.test(id)))
      || (grant.roleId && !grant.guildId)
      || (grant.roles !== undefined && (!Array.isArray(grant.roles) || grant.roles.some(r => !Object.hasOwn(PRESETS, r))))
      || (grant.capabilities !== undefined && (!Array.isArray(grant.capabilities) || grant.capabilities.some(c => !CAPABILITIES.includes(c))))) {
      throw new Error("Invalid rights grant: use a user ID or a guild-scoped role ID and known capabilities/presets.");
    }
    if (grant.guildId && (grant.roles?.includes("bot-admin") || grant.capabilities?.includes("bot.manage"))) {
      throw new Error("Bot administration can only be granted globally to individual users.");
    }
    return grant;
  });
}

export function createAccessPolicy(env: NodeJS.ProcessEnv = process.env) {
  const allowed = ids(env.DISCORD_ALLOWED_USERS);
  const admins = ids(env.DISCORD_ADMIN_USERS);
  const grants = env.DISCORD_RIGHTS_FILE?.trim()
    ? parseGrants(JSON.parse(fs.readFileSync(env.DISCORD_RIGHTS_FILE.trim(), "utf8"))) : [];
  const matches = (g: Grant, s: AccessSubject) => (g.userId === s.userId || Boolean(g.roleId && s.roleIds?.includes(g.roleId)))
    && (!g.guildId || g.guildId === s.guildId);
  const explicitAdmin = (s: AccessSubject) => admins.has(s.userId) || grants.some(g => !g.guildId && matches(g, s)
    && (g.roles?.includes("bot-admin") || g.capabilities?.includes("bot.manage")));
  const granted = (s: AccessSubject, capability: Capability) => grants.some(g => matches(g, s)
    && (g.capabilities?.includes(capability) || g.roles?.some(role => (PRESETS[role] as readonly string[]).includes(capability))));
  const legacyMessage = (userId: string) => allowed.size === 0 || allowed.has(userId);
  const legacyAdmin = (userId: string) => admins.size > 0 ? admins.has(userId) : legacyMessage(userId);
  return {
    isExplicitAdmin: explicitAdmin,
    // Retained for existing context-author filters and compatibility callers.
    canMessage: (userId: string, subject: AccessSubject = { userId }) => legacyMessage(userId) || granted(subject, "chat.use"),
    canUseAdminCommands: (userId: string) => legacyAdmin(userId) || explicitAdmin({ userId }),
    can(s: AccessSubject, capability: Capability, resource: AccessResource = {}): boolean {
      if (!CAPABILITIES.includes(capability)) return false;
      if (resource.guildId && resource.guildId !== s.guildId) return false;
      if (capability === "schedule.manage.own" && resource.ownerId && resource.ownerId !== s.userId) return false;
      if (capability.startsWith("schedule.")) {
        if (!s.guildId) return false;
        // Legacy open-admin fallback never grants unattended execution.
        if (capability === "schedule.ai.create") return explicitAdmin(s);
        return explicitAdmin(s) || granted(s, capability);
      }
      if (explicitAdmin(s) || granted(s, capability)) return true;
      return capability === "chat.use" ? legacyMessage(s.userId) || legacyAdmin(s.userId) : legacyAdmin(s.userId);
    },
  };
}
export type AccessPolicy = ReturnType<typeof createAccessPolicy>;
export interface SlashCommandRequest { commandName: string; subcommand?: string | null; hasWorkspace?: boolean }
export function slashCommandCapability({ commandName: command, subcommand: sub, hasWorkspace }: SlashCommandRequest): Capability | undefined {
  if (["ask", "chat"].includes(command) && !sub) return hasWorkspace ? "workspace.manage" : "chat.use";
  if (["reset", "history", "compact"].includes(command) && !sub) return "chat.use";
  if (["servers", "leave", "status", "fleet"].includes(command) && !sub) return "bot.manage";
  const read: Record<string, string[]> = {
    model: ["list", "current"], reasoning: ["list", "current"], provider: ["list", "current"],
    agent: ["list", "current"], mode: ["get"], plan: ["read", "update", "delete"],
  };
  if (sub && read[command]?.includes(sub)) return "chat.use";
  if ((["model", "reasoning", "provider", "mode"].includes(command) && sub === "set")
    || (command === "agent" && ["select", "deselect"].includes(sub ?? ""))) return "session.configure";
  if (command === "workspace" && ["list", "read", "create"].includes(sub ?? "")) return "workspace.manage";
  if (command === "mcp" && ["list", "enable", "disable", "workspace"].includes(sub ?? "")) return "mcp.manage";
  return undefined;
}
export function slashCommandRequiresAdmin(request: SlashCommandRequest): boolean {
  return slashCommandCapability(request) !== "chat.use";
}
export function canInvokeSlashCommand(access: AccessPolicy, userId: string, request: SlashCommandRequest, subject: AccessSubject = { userId }): boolean {
  const capability = slashCommandCapability(request);
  // Preserve legacy unknown-command classification; the dispatcher never executes unmapped commands.
  return capability ? access.can(subject, capability) : access.canUseAdminCommands(userId);
}
