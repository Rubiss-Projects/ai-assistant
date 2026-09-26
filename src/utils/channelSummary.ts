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
  const guidance = "Please specify 'since my last message', 'since MESSAGE_LINK', 'the last N messages', or 'the last N hours/minutes/days'. Bare clock times need a date and timezone; a message link is unambiguous.";
  // Check the entire interval, including constraints left after a supported range.
  const validate = (range: Range, matched = ""): Range | string => {
    const remainder = prompt.replace(matched, "").replace(/\bthis\s+(?:channel|chat|conversation)\b/gi, "");
    const temporalConstraints = [
      /\b(?:older|newer|earlier|later)\s+than\b|\b\d+\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago\b/i,
      /\b(?:last|past|previous|next|recent)\s+\d/i,
      /\b(?:since|after|before|between)\b/i,
      /\b(?:yesterday|today|tomorrow|tonight)\b/i,
      /\b(?:last|past|previous|next|this|recent)\s+(?:(?:\d+(?:\.\d+)?|a|an|one|two|few|several)\s+)?(?:messages?|seconds?|minutes?|hours?|days?|weeks?|months?|years?|morning|afternoon|evening|night|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
      /\b(?:on|in|from|during|over|until|through|at)\s+(?:(?:the|early|late)\s+)?(?:\d{1,4}\b|january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|night|weekend)\b/i,
      /\b\d{1,4}[-/]\d{1,2}(?:[-/]\d{1,4})?\b|\b\d{1,2}:\d{2}\b/i,
    ];
    if (temporalConstraints.some(pattern => pattern.test(remainder.replace(/\brecent\s+(?:messages?|conversation|chat)\b/gi, "")))) return "Unsupported range. " + guidance;
    return range;
  };
  const channels = [...prompt.matchAll(/<#(\d+)>/g)];
  if (channels.some(match => match[1] !== invocation.channelId)) return "Request the summary in the channel you want summarized.";
  const previous = prompt.match(/\bsince my (?:last|previous) message\b(?:\s+at\s+\d{1,2}:\d{2}(?:\s*[ap]m)?)?/i);
  if (previous) return validate({ kind: "last" }, previous[0]);
  const link = prompt.match(/\b(?:since|after)\s+(https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+))/i);
  if (link) {
    if (link[2] !== invocation.guildId || link[3] !== invocation.channelId) return "The starting message must belong to this channel.";
    if (BigInt(link[4]) >= BigInt(invocation.id)) return "The starting message must be older than this request.";
    return validate({ kind: "after", id: link[4] }, link[0]);
  }
  const duration = prompt.match(/\b(?:(?:from|over|in|during)\s+)?(?:the\s+)?(?:last|past)\s+(\d+)\s+(minutes?|hours?|days?)\b/i);
  if (duration) {
    const amount = Number(duration[1]);
    if (amount < 1 || amount > CHANNEL_SUMMARY_CAPABILITIES.limits.durationAmount) return `Use a duration between 1 and ${CHANNEL_SUMMARY_CAPABILITIES.limits.durationAmount} minutes, hours, or days.`;
    const unit = duration[2].toLowerCase();
    return validate({ kind: "time", timestamp: invocation.createdTimestamp - amount * (unit.startsWith("minute") ? 60_000 : unit.startsWith("hour") ? 3_600_000 : 86_400_000) }, duration[0]);
  }
  const count = prompt.match(/\b(?:(?:from|over|in|during)\s+)?(?:the\s+)?(?:last|recent)\s+(\d+)\s+messages?\b/i);
  if (count && (Number(count[1]) < 1 || Number(count[1]) > SCAN_LIMIT)) return `Choose between 1 and ${SCAN_LIMIT} messages.`;
  if (count) return validate({ kind: "recent", count: Number(count[1]) }, count[0]);
  // A default is safe only when no unsupported interval remains.
  return validate({ kind: "recent", count: CHANNEL_SUMMARY_CAPABILITIES.limits.defaultMessages });
}

/** Host-side chronological retrieval; history is data, never a new invocation. */
export async function channelSummaryContext(invocation: Invocation, prompt: string, client: Client, canIncludeAuthor: (id: string) => boolean): Promise<string | null> {
  // Guild-history enrichment must not intercept ordinary DM session summaries.
  if (!invocation.guildId || !isChannelSummaryRequest(prompt)) return null;
  const notice = (text: string) => `[Channel summary unavailable: ${text} Explain this limitation; do not invent a summary from other context.]\n\n${prompt}`;
  const range = rangeFor(prompt, invocation);
  if (typeof range === "string") return notice(range);
  return retrieveChannelSummary(invocation, prompt, range, client, canIncludeAuthor);
}

async function retrieveChannelSummary(invocation: Invocation, prompt: string, range: Range, client: Client, canIncludeAuthor: (id: string) => boolean, signal?: AbortSignal): Promise<string> {
  const notice = (text: string) => `[Channel summary unavailable: ${text} Explain this limitation; do not invent a summary from other context.]\n\n${prompt}`;
  const requester = "user" in invocation ? invocation.user.id : invocation.author.id;
  try {
    signal?.throwIfAborted();
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
      signal?.throwIfAborted();
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
    signal?.throwIfAborted();
    const partial = !done || clipped;
    return `[Channel summary source]\n${CHANNEL_SUMMARY_SOURCE_INSTRUCTIONS}\n${JSON.stringify({ channelId: channel.id, range, anchor, scanned, included: records.length, partial, coverage: partial ? "PARTIAL: retrieval or text limit reached; older messages omitted" : "Requested range retrieved", exclusions: "Bot messages and authors excluded by access policy are omitted. Attachments are counted, not read.", empty: records.length === 0 })}\n${records.reverse().join("\n")}\n[/Channel summary source]\n\n${prompt}`;
  } catch {
    return notice("Discord history could not be retrieved. Please try again; no complete summary is available.");
  }
}

/** Bind identity, channel and cutoff to the current host invocation, never tool arguments. */
export function channelHistoryResolver(invocation: Invocation, client: Client, canIncludeAuthor: (id: string) => boolean = () => true) {
  // Snapshot the boundary before a queued response begins.
  const source = {
    id: invocation.id, guildId: invocation.guildId, channelId: invocation.channelId,
    createdTimestamp: invocation.createdTimestamp,
    author: { id: "user" in invocation ? invocation.user.id : invocation.author.id },
  } as Invocation;
  return async (args: Record<string, unknown>, signal?: AbortSignal): Promise<string> => {
    if (!source.guildId) throw new Error("Channel history is unavailable in DMs. Use the existing conversation context.");
    const fields: Record<string, string[]> = { previous_message: [], recent: ["count"], after_message: ["message_url"], relative_time: ["amount", "unit"] };
    const kind = typeof args.range === "string" ? args.range : "";
    if (!Object.hasOwn(fields, kind) || Object.keys(args).some(key => !["run_id", "range", ...fields[kind]].includes(key))) throw new Error("Choose one supported range without additional constraints.");
    const integer = (value: unknown, limit: number): number => {
      if (typeof value !== "string" || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > limit) throw new Error(`Use an integer between 1 and ${limit}.`);
      return Number(value);
    };
    let range: Range;
    if (kind === "previous_message") range = { kind: "last" };
    else if (kind === "recent") range = { kind: "recent", count: args.count === undefined ? CHANNEL_SUMMARY_CAPABILITIES.limits.defaultMessages : integer(args.count, SCAN_LIMIT) };
    else if (kind === "relative_time") {
      const units: Record<string, number> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
      if (typeof args.unit !== "string" || !Object.hasOwn(units, args.unit)) throw new Error("Choose minutes, hours, or days.");
      range = { kind: "time", timestamp: source.createdTimestamp - integer(args.amount, CHANNEL_SUMMARY_CAPABILITIES.limits.durationAmount) * units[args.unit] };
    } else {
      const link = typeof args.message_url === "string" ? args.message_url.match(/^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)$/i) : null;
      if (!link || link[1] !== source.guildId || link[2] !== source.channelId) throw new Error("Provide a message link from the invoking channel.");
      if (BigInt(link[3]) >= BigInt(source.id)) throw new Error("The starting message must be older than this request.");
      range = { kind: "after", id: link[3] };
    }
    return retrieveChannelSummary(source, "", range, client, canIncludeAuthor, signal);
  };
}
