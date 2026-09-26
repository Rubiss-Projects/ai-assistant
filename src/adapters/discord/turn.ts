import { homedir } from 'node:os';
import { join } from 'node:path';
import { ConversationService } from '../../application/conversationService.js';
import { FileTurnJournal } from '../../application/conversationService.js';
import { TEXT_CAPABILITIES } from '../../core/conversation.js';
import type { AgentResponse, SendAttachment, SendMessageOptions } from '../../providers/types.js';
import type { SessionManager } from '../../sessionManager.js';
import { discordSubject } from '../../common/discordAccess.js';
import { canInvokeSlashCommand } from '../../common/accessPolicy.js';
import type { Client } from 'discord.js';
const services = new WeakMap<object, ConversationService>();
/** Production installs durable ownership before logging in; unit fixtures use isolated memory. */
export function installDiscordConversations(sessions: SessionManager): ConversationService {
  const existing = services.get(sessions); if (existing) return existing;
  const dir = process.env.AI_ASSISTANT_STATE_DIR ?? join(homedir(), '.config', 'ai-assistant', 'adapters');
  const service = new ConversationService(new FileTurnJournal(join(dir, 'discord-turns')));
  services.set(sessions, service); return service;
}
export function discordConversations(sessions: SessionManager): ConversationService {
  let service = services.get(sessions); if (!service) { service = new ConversationService(); services.set(sessions, service); } return service;
}
export async function executeDiscordTurn(
  sessions: SessionManager,
  source: { id: string; guildId: string | null; channelId: string; client?: Client; author?: { id: string }; user?: { id: string }; commandName?: string; options?: { getString(name: string, required?: boolean): string | null; getSubcommand(required?: boolean): string | null } },
  key: string, prompt: string, attachments: SendAttachment[] | undefined, options: SendMessageOptions,
  deliver: (response: AgentResponse, sessionKey: string) => Promise<void>,
  prepare?: (key: string) => Promise<{ prompt: string; attachments?: SendAttachment[]; cleanup?(): Promise<void> }>,
  resolveSession?: () => Promise<string>,
  coordinate?: (key: string, run: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const actor = source.author?.id ?? source.user!.id;
  const tenantId = source.guildId ?? 'direct';
  const service = discordConversations(sessions);
  let originalError: unknown;
  const handle = await service.submit({ eventId: source.id, sourceMessageId: source.id, text: prompt,
    actor: { platform: 'discord', tenantId, userId: actor }, receivedAt: new Date().toISOString(),
    conversation: { platform: 'discord', tenantId, installationId: 'default', channelId: source.channelId, kind: source.guildId ? 'channel' : 'direct' },
  }, {
    onError: error => { originalError = error; },
    resolveSession, coordinate,
    platform: 'discord', tenantId, installationId: 'default', audience: 'individual', legacySessionKey: key,
    capabilities: { ...TEXT_CAPABILITIES, attachments: true, history: true, messageLinks: true, memory: true, schedules: true, directMessages: true },
    authorize: async () => {
      if (!options.rulesetContext) return true; // Compatibility for isolated handler callers; bot ingress always supplies policy.
      const { access, requester } = options.rulesetContext;
      const current = source.client ? await discordSubject(source.client, actor, source.guildId) : requester;
      return source.commandName ? canInvokeSlashCommand(access, actor, { commandName: source.commandName,
        subcommand: source.options?.getSubcommand(false), hasWorkspace: Boolean(source.options?.getString('workspace', false)) }, current) : access.canMessage(actor, current);
    },
    prepare: async (_input, session) => prepare ? prepare(session) : ({ prompt, attachments }),
    generate: (prepared, session, _signal, onProgress) => sessions.sendMessage(session, prepared.prompt, prepared.attachments, { ...options, onProgress }),
    progress: async update => { await options.onProgress?.(update); },
    deliver: async (response, _id, session) => { await deliver(response, session); return { messageIds: [] }; },
  });
  const result = await handle.completion;
  if (result.state !== 'delivered') throw originalError ?? new Error(result.error ?? 'Conversation failed.');
}
