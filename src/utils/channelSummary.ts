import { ChannelType, PermissionFlagsBits, Routes, type Client, type Message, type ChatInputCommandInteraction } from "discord.js";
import type { APIMessage } from "discord-api-types/v10";
import { CHANNEL_SUMMARY_CAPABILITIES, CHANNEL_SUMMARY_SOURCE_INSTRUCTIONS } from "../common/channelSummaryContract.js";

const SCAN_LIMIT = CHANNEL_SUMMARY_CAPABILITIES.limits.scannedMessages;
const TEXT_LIMIT = CHANNEL_SUMMARY_CAPABILITIES.limits.sourceCharacters;
type Invocation = Message | ChatInputCommandInteraction;
type Range = { kind: "last" } | { kind: "recent"; count: number } | { kind: "after"; id: string } | { kind: "time"; timestamp: number };

export function isChannelSummaryRequest(prompt: string): boolean {
  const request = prompt.trim().match(/(?:^|\b(?:can|could|would|will) you\s+)(?:please\s+)?((?:summari[sz]e|recap)\b[\s\S]*)/i)?.[1];
  if (!request) return false;
  return /\b(?:summari[sz]e|recap)\s+(?:(?:all|the|these|recent|last|this|our|channel|\d+)\s+)*(?:messages?|conversation|chat|channel|everything)\b/i.test(request)
    || /\b(?:summari[sz]e|recap)\b.*\bsince my (?:last|previous) message\b/i.test(request);
}

function rangeFor(prompt: string, invocation: Invocation): Range | string {
  const channels = [...prompt.matchAll(/<#(\d+)>/g)];
  if (channels.some(match => match[1] !== invocation.channelId)) return "Request the summary in the channel you want summarized.";
  if (/\bsince my (?:last|previous) message\b/i.test(prompt)) return { kind: "last" };
  const link = prompt.match(/\b(?:since|after)\s+(https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+))/i);
  if (link) {
    if (link[2] !== invocation.guildId || link[3] !== invocation.channelId) return "The starting message must belong to this channel.";
    if (BigInt(link[4]) >= BigInt(invocation.id)) return "The starting message must be older than this request.";
    return { kind: "after", id: link[4] };
  }
  const duration = prompt.match(/\b(?:last|past)\s+(\d+)\s+(minutes?|hours?|days?)\b/i);
  if (duration) {
    const amount = Number(duration[1]);
    if (amount < 1 || amount > CHANNEL_SUMMARY_CAPABILITIES.limits.durationAmount) return `Use a duration between 1 and ${CHANNEL_SUMMARY_CAPABILITIES.limits.durationAmount} minutes, hours, or days.`;
    const unit = duration[2].toLowerCase();
    return { kind: "time", timestamp: invocation.createdTimestamp - amount * (unit.startsWith("minute") ? 60_000 : unit.startsWith("hour") ? 3_600_000 : 86_400_000) };
  }
  if (/\b(?:since|after|before|between|yesterday|today)\b|\b\d{1,2}:\d{2}\b/i.test(prompt)) return "Please specify 'since my last message', 'since MESSAGE_LINK', 'the last N messages', or 'the last N hours/minutes/days'. Bare clock times need a date and timezone; a message link is unambiguous.";
  const count = prompt.match(/\b(?:last|recent)\s+(\d+)\s+messages?\b/i);
  if (count && (Number(count[1]) < 1 || Number(count[1]) > SCAN_LIMIT)) return `Choose between 1 and ${SCAN_LIMIT} messages.`;
  if (!count && /\b(?:last|past|previous|from|on|during|this|over)\b|\b\d{4}-\d{1,2}-\d{1,2}\b/i.test(prompt.replace(/\bthis\s+(?:channel|chat|conversation)\b/gi, ""))) return "Unsupported range. Please use 'since my last message', 'since MESSAGE_LINK', 'the last N messages', or 'the last N hours/minutes/days'.";
  return { kind: "recent", count: count ? Number(count[1]) : CHANNEL_SUMMARY_CAPABILITIES.limits.defaultMessages };
}

/** Host-side chronological retrieval; history is data, never a new invocation. */
export async function channelSummaryContext(invocation: Invocation, prompt: string, client: Client, canIncludeAuthor: (id: string) => boolean): Promise<string | null> {
  if (!isChannelSummaryRequest(prompt)) return null;
  const notice = (text: string) => `[Channel summary unavailable: ${text} Explain this limitation; do not invent a summary from other context.]\n\n${prompt}`;
  if (!invocation.guildId) return notice("Use a server channel.");
  const range = rangeFor(prompt, invocation);
  if (typeof range === "string") return notice(range);
  const requester = "user" in invocation ? invocation.user.id : invocation.author.id;
  try {
    const channel = await client.channels.fetch(invocation.channelId);
    if (!channel || channel.isDMBased() || !("guildId" in channel) || channel.guildId !== invocation.guildId || !("messages" in channel)) return notice("This channel has no readable message history.");
    for (const id of [requester, client.user?.id]) {
      if (!id || !channel.permissionsFor(id)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) return notice("You and the bot both need View Channel and Read Message History permissions.");
      if (channel.isThread() && channel.type === ChannelType.PrivateThread && !channel.permissionsFor(id)?.has(PermissionFlagsBits.ManageThreads)) {
        if (!await channel.members.fetch(id).catch(() => null)) return notice("Private thread membership could not be verified.");
      }
    }
    if (range.kind === "after") {
      const startingMessage = await client.rest.get(Routes.channelMessage(channel.id, range.id)).catch(() => null) as APIMessage | null;
      if (!startingMessage || startingMessage.id !== range.id || startingMessage.channel_id !== channel.id) return notice("The starting message could not be retrieved. Supply an existing message link or a recent-message count.");
    }
    let before = invocation.id;
    let scanned = 0;
    let done = false;
    let anchorFound = false;
    let anchor: string | undefined;
    const selected: APIMessage[] = [];
    while (scanned < SCAN_LIMIT && !done) {
      const limit = Math.min(CHANNEL_SUMMARY_CAPABILITIES.limits.pageMessages, SCAN_LIMIT - scanned, range.kind === "recent" ? range.count - scanned : SCAN_LIMIT);
      const page = await client.rest.get(Routes.channelMessages(channel.id), { query: new URLSearchParams({ before, limit: String(limit) }) }) as APIMessage[];
      if (page.length === 0) { done = true; break; }
      const ordered = page.filter(message => BigInt(message.id) < BigInt(before))
        .sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : BigInt(a.id) < BigInt(b.id) ? 1 : 0);
      if (!ordered.length) return notice("History pagination did not advance. Please try again.");
      for (const message of ordered) {
        scanned++;
        if (range.kind === "last" && message.author.id === requester) {
          anchorFound = true; anchor = `https://discord.com/channels/${invocation.guildId}/${channel.id}/${message.id}`; done = true; break;
        }
        if ((range.kind === "after" && BigInt(message.id) <= BigInt(range.id)) || (range.kind === "time" && Date.parse(message.timestamp) <= range.timestamp)) { done = true; break; }
        if (!message.author.bot && canIncludeAuthor(message.author.id)) selected.push(message);
      }
      before = ordered[ordered.length - 1].id;
      if (page.length < limit || (range.kind === "recent" && scanned >= range.count)) done = true;
    }
    if (range.kind === "last" && !anchorFound) return notice(`Your previous message was not found within ${scanned} scanned messages. Supply a starting message link or a recent-message count.`);
    const records: string[] = [];
    let size = 0;
    let clipped = false;
    // Keep the newest complete records within the context budget, then reverse.
    for (const message of selected) {
      const record = JSON.stringify({
        author: message.author.global_name ?? message.author.username,
        authorId: message.author.id,
        timestamp: message.timestamp,
        url: `https://discord.com/channels/${invocation.guildId}/${channel.id}/${message.id}`,
        text: message.content,
        attachments: message.attachments.length,
      });
      if (size + record.length + 1 > TEXT_LIMIT) { clipped = true; break; }
      records.push(record); size += record.length + 1;
    }
    const partial = !done || clipped;
    return `[Channel summary source]\n${CHANNEL_SUMMARY_SOURCE_INSTRUCTIONS}\n${JSON.stringify({ channelId: channel.id, range, anchor, scanned, included: records.length, partial, coverage: partial ? "PARTIAL: retrieval or text limit reached; older messages omitted" : "Requested range retrieved", exclusions: "Bot messages and authors excluded by access policy are omitted. Attachments are counted, not read.", empty: records.length === 0 })}\n${records.reverse().join("\n")}\n[/Channel summary source]\n\n${prompt}`;
  } catch {
    return notice("Discord history could not be retrieved. Please try again; no complete summary is available.");
  }
}
