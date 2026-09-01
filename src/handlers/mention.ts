import { Message, Client } from "discord.js";
import { SessionManager, chunkForDiscord, runTimeoutMessage } from "../sessionManager.js";
import { resolveMessageLinks } from "../utils/resolveMessageLinks.js";
import { resolveDiscordContext } from "../utils/resolveDiscordContext.js";
import { downloadFileAttachments, prepareDownloadedAttachments } from "../utils/downloadAttachments.js";
import { enrichWithDiscordKnowledge } from "../utils/discordKnowledge.js";
import { progressMessage } from "../common/progressMessage.js";
import { deliverDiscordAttachments, discordTextOptions } from "../common/discordResponse.js";
import type { AgentResponse } from "../providers/types.js";

export function mentionSessionKey(message: Pick<Message, "guildId" | "channelId" | "author">): string {
  return message.guildId ? `${message.author.id}:${message.channelId}` : message.author.id;
}

export async function deliverMentionResponse(
  sourceMessage: Pick<Message, "reply">,
  progressReply: Pick<Message, "edit" | "reply"> | undefined,
  response: AgentResponse,
): Promise<void> {
  const chunks = chunkForDiscord(response.content);
  if (progressReply) {
    try {
      await progressReply.edit(discordTextOptions(chunks[0]));
    } catch (error) {
      console.warn("[mention] Could not replace the progress message; sending a new reply:", error);
      for (let index = 0; index < chunks.length; index++) {
        await sourceMessage.reply(discordTextOptions(chunks[index]));
      }
      await deliverDiscordAttachments(
        (options) => sourceMessage.reply(options),
        response.attachments,
      );
      return;
    }

    for (let index = 1; index < chunks.length; index++) {
      try {
        await progressReply.reply(discordTextOptions(chunks[index]));
      } catch (error) {
        console.warn("[mention] Could not send an overflow reply; retrying the unsent remainder:", error);
        for (const unsentChunk of chunks.slice(index)) {
          try {
            await sourceMessage.reply(discordTextOptions(unsentChunk));
          } catch (fallbackError) {
            console.error("[mention] Could not deliver the remaining response:", fallbackError);
            return;
          }
        }
        await deliverDiscordAttachments(
          (options) => sourceMessage.reply(options),
          response.attachments,
        );
        return;
      }
    }
    await deliverDiscordAttachments(
      (options) => progressReply.reply(options),
      response.attachments,
    );
    return;
  }

  for (const chunk of chunks) {
    await sourceMessage.reply(discordTextOptions(chunk));
  }
  await deliverDiscordAttachments((options) => sourceMessage.reply(options), response.attachments);
}

export async function handleMention(
  message: Message,
  client: Client,
  sessions: SessionManager,
  sessionKey?: string,  // defaults to a per-user, per-channel key; pass channelId for shared thread sessions
  canIncludeContextAuthor: (authorId: string) => boolean = () => true
): Promise<void> {
  // Strip all @mentions of the bot and trim
  const botMentionPattern = new RegExp(`<@!?${client.user!.id}>`, "g");
  const prompt = message.content.replace(botMentionPattern, "").trim();

  const contextAttachments: Array<{ url: string; contentType: string | null; name: string; size?: number }> = [];
  let cleanup = async (): Promise<void> => {};
  let typingInterval: ReturnType<typeof setInterval> | undefined;
  let progressReply: Message | undefined;
  let progressUpdates = Promise.resolve();

  try {
    if (!prompt && message.attachments.size === 0 && !message.reference?.messageId) {
      await message.reply(
        "👋 Hi! Mention me with a question or command. Use `/ask` for one-shot queries, `/chat` for persistent conversation, or `/reset` to clear your history."
      );
      return;
    }

    const key = sessionKey ?? mentionSessionKey(message);
    const basePrompt = prompt || (message.reference?.messageId
      ? "Respond using the replied-to conversation context."
      : "See the attached file(s).");
    const knowledgePrompt = await enrichWithDiscordKnowledge(
      message,
      basePrompt,
      client,
      canIncludeContextAuthor,
      (internalPrompt) => sessions.runEphemeral(key, internalPrompt),
    );
    const linkedPrompt = await resolveMessageLinks(knowledgePrompt, client, message.author.id, contextAttachments);
    let enrichedPrompt = await resolveDiscordContext(
      message,
      linkedPrompt,
      message.mentions.has(client.user!.id),
      canIncludeContextAuthor,
      contextAttachments,
    );
    const result = await downloadFileAttachments([
      ...message.attachments.values(),
      ...contextAttachments,
    ]);
    cleanup = result.cleanup;
    const prepared = await prepareDownloadedAttachments(result.attachments);
    if (prepared.textContext) enrichedPrompt = `${enrichedPrompt}\n\n${prepared.textContext}`;

    // Keep typing indicator alive every 8s (Discord clears it after ~10s)
    if ("sendTyping" in message.channel) {
      await message.channel.sendTyping();
      typingInterval = setInterval(() => {
        if ("sendTyping" in message.channel) {
          message.channel.sendTyping().catch(() => {});
        }
      }, 8000);
    }

    const response = await sessions.sendMessage(
      key,
      enrichedPrompt,
      prepared.fileAttachments.length ? prepared.fileAttachments : undefined,
      {
        onProgress: ({ elapsedMs }) => {
          progressUpdates = progressUpdates.catch(() => {}).then(async () => {
            const content = progressMessage(elapsedMs);
            if (progressReply) await progressReply.edit(content);
            else progressReply = await message.reply(content);
          });
          return progressUpdates;
        },
      },
    );

    await progressUpdates.catch(() => {});
    await deliverMentionResponse(message, progressReply, response);
  } catch (err) {
    console.error("[mention] Error:", err);
    const failure = runTimeoutMessage(err) ?? "❌ Something went wrong talking to the AI. Please try again.";
    await progressUpdates.catch(() => {});
    if (progressReply) await progressReply.edit(failure).catch(() => message.reply(failure).then(() => {}));
    else await message.reply(failure);
  } finally {
    clearInterval(typingInterval);
    await cleanup();
  }
}
