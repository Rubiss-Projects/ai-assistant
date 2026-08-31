import { Message, Client } from "discord.js";
import { SessionManager, chunkForDiscord } from "../sessionManager.js";
import { resolveMessageLinks } from "../utils/resolveMessageLinks.js";
import { resolveDiscordContext } from "../utils/resolveDiscordContext.js";
import { downloadFileAttachments, prepareDownloadedAttachments } from "../utils/downloadAttachments.js";
import { enrichWithDiscordKnowledge } from "../utils/discordKnowledge.js";

export async function handleMention(
  message: Message,
  client: Client,
  sessions: SessionManager,
  sessionKey?: string,  // defaults to message.author.id; pass channelId for thread sessions
  canIncludeContextAuthor: (authorId: string) => boolean = () => true
): Promise<void> {
  // Strip all @mentions of the bot and trim
  const botMentionPattern = new RegExp(`<@!?${client.user!.id}>`, "g");
  const prompt = message.content.replace(botMentionPattern, "").trim();

  const contextAttachments: Array<{ url: string; contentType: string | null; name: string; size?: number }> = [];
  let cleanup = async (): Promise<void> => {};
  let typingInterval: ReturnType<typeof setInterval> | undefined;

  try {
    if (!prompt && message.attachments.size === 0 && !message.reference?.messageId) {
      await message.reply(
        "👋 Hi! Mention me with a question or command. Use `/ask` for one-shot queries, `/chat` for persistent conversation, or `/reset` to clear your history."
      );
      return;
    }

    const key = sessionKey ?? message.author.id;
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
      prepared.fileAttachments.length ? prepared.fileAttachments : undefined
    );

    const chunks = chunkForDiscord(response);
    await message.reply(chunks[0]);
    for (const chunk of chunks.slice(1)) {
      await message.reply(chunk);
    }
  } catch (err) {
    console.error("[mention] Error:", err);
    await message.reply("❌ Something went wrong talking to the AI. Please try again.");
  } finally {
    clearInterval(typingInterval);
    await cleanup();
  }
}
