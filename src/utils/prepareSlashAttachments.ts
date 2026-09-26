import type { Attachment, Client } from "discord.js";
import { downloadFileAttachments, prepareDownloadedAttachments } from "./downloadAttachments.js";
import { resolveMessageLinks } from "./resolveMessageLinks.js";
import { enrichDiscordRequest } from "./discordKnowledge.js";
import type { ChatInputCommandInteraction } from "discord.js";
import type { ConversationMessage } from "../common/chatParticipation.js";
import type { SendAttachment } from "../providers/types.js";

export async function prepareSlashAttachments(
  prompt: string,
  client: Client,
  requestingUserId: string,
  directAttachment?: Attachment | null,
  interaction?: ChatInputCommandInteraction,
  canIncludeContextAuthor: (authorId: string) => boolean = () => true,
  infer?: (prompt: string) => Promise<string>,
  contextAttachments: NonNullable<ConversationMessage["attachments"]> = [],
): Promise<{
  prompt: string;
  isChannelSummary: boolean;
  attachments: SendAttachment[];
  cleanup: () => Promise<void>;
}> {
  const linkedAttachments: Array<{
    url: string;
    contentType: string | null;
    name: string;
    size?: number;
  }> = [];
  const knowledge = interaction
    ? await enrichDiscordRequest(interaction, prompt, client, canIncludeContextAuthor, infer)
    : { prompt, isChannelSummary: false };
  const enrichedPrompt = knowledge.isChannelSummary ? knowledge.prompt : await resolveMessageLinks(
    knowledge.prompt,
    client,
    requestingUserId,
    linkedAttachments,
    canIncludeContextAuthor,
    prompt,
  );
  const result = await downloadFileAttachments([
    ...(directAttachment ? [directAttachment] : []),
    ...linkedAttachments,
    ...(knowledge.isChannelSummary ? [] : contextAttachments),
  ]);

  try {
    const prepared = await prepareDownloadedAttachments(result.attachments);
    return {
      isChannelSummary: knowledge.isChannelSummary,
      prompt: [enrichedPrompt, prepared.textContext, ...result.warnings.map((warning) => `[Input attachment unavailable: ${warning}]`)].filter(Boolean).join("\n\n"),
      attachments: prepared.fileAttachments,
      cleanup: result.cleanup,
    };
  } catch (error) {
    await result.cleanup();
    throw error;
  }
}
