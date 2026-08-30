import type { APIEmbed, Message } from "discord.js";

const REPLY_CONTEXT_LIMIT = 7;
const RECENT_CONTEXT_LIMIT = 6;

function quoteLines(value: string): string {
  return value.split("\n").map((line) => `> ${line}`).join("\n");
}

function embedText(embeds: readonly APIEmbed[]): string[] {
  return embeds.flatMap((embed) => {
    const lines: string[] = [];
    if (embed.author?.name) lines.push(`Embed author: ${embed.author.name}`);
    if (embed.title) lines.push(`Embed title: ${embed.title}`);
    if (embed.description) lines.push(embed.description);
    for (const field of embed.fields ?? []) lines.push(`${field.name}: ${field.value}`);
    if (embed.footer?.text) lines.push(`Embed footer: ${embed.footer.text}`);
    return lines;
  });
}

function formatContextMessage(message: Message, referencedMessageId: string): string {
  const author = message.member?.displayName ?? message.author.globalName ?? message.author.username;
  const marker = message.id === referencedMessageId ? " [replied-to message]" : "";
  const body = [message.content, ...embedText(message.embeds.map((embed) => embed.toJSON()))]
    .filter((value): value is string => Boolean(value?.trim()));

  if (message.attachments.size > 0) {
    body.push(`[${message.attachments.size} attachment(s)]`);
  }

  return `${author} (${message.createdAt.toISOString()})${marker}:\n${quoteLines(body.join("\n") || "(no text content)")}`;
}

/**
 * Adds relevant channel conversation to a prompt. Replies are centered around
 * the referenced message; ordinary mention-triggered messages use the most
 * recent messages preceding the invocation.
 */
export async function resolveDiscordContext(
  message: Message,
  content: string,
  includeRecentContext = false
): Promise<string> {
  const referencedMessageId = message.reference?.messageId;
  if ((!referencedMessageId && !includeRecentContext) || !("messages" in message.channel)) {
    return content;
  }

  try {
    const fetched = referencedMessageId
      ? await message.channel.messages.fetch({
          around: referencedMessageId,
          limit: REPLY_CONTEXT_LIMIT,
        })
      : await message.channel.messages.fetch({
          before: message.id,
          limit: RECENT_CONTEXT_LIMIT,
        });

    const messages = [...fetched.values()].filter((candidate) => candidate.id !== message.id);

    if (referencedMessageId && !messages.some((candidate) => candidate.id === referencedMessageId)) {
      messages.push(await message.fetchReference());
    }

    if (messages.length === 0) return content;

    const context = messages
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map((candidate) => formatContextMessage(candidate, referencedMessageId ?? ""));

    const label = referencedMessageId ? "Discord reply context" : "Recent Discord conversation";
    return `[${label}]\n${context.join("\n\n")}\n[/${label}]\n\n${content}`;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return `[Could not fetch Discord reply context: ${reason}]\n\n${content}`;
  }
}
