import type { Attachment, Client } from "discord.js";
import { downloadFileAttachments, prepareDownloadedAttachments } from "./downloadAttachments.js";
import { resolveMessageLinks } from "./resolveMessageLinks.js";
import { enrichWithDiscordKnowledge } from "./discordKnowledge.js";
import type { ChatInputCommandInteraction } from "discord.js";
import type { SendAttachment } from "../providers/types.js";

export async function prepareSlashAttachments(
  prompt: string,
  client: Client,
  requestingUserId: string,
  directAttachment?: Attachment | null,
  interaction?: ChatInputCommandInteraction,
  canIncludeContextAuthor: (authorId: string) => boolean = () => true,
  infer?: (prompt: string) => Promise<string>,
): Promise<{
  prompt: string;
  attachments: SendAttachment[];
  cleanup: () => Promise<void>;
}> {
  const linkedAttachments: Array<{
    url: string;
    contentType: string | null;
    name: string;
    size?: number;
  }> = [];
  const knowledgePrompt = interaction
    ? await enrichWithDiscordKnowledge(interaction, prompt, client, canIncludeContextAuthor, infer)
    : prompt;
  const enrichedPrompt = await resolveMessageLinks(
    knowledgePrompt,
    client,
    requestingUserId,
    linkedAttachments,
    canIncludeContextAuthor,
  );
  const result = await downloadFileAttachments([
    ...(directAttachment ? [directAttachment] : []),
    ...linkedAttachments,
  ]);

  try {
    const prepared = await prepareDownloadedAttachments(result.attachments);
    return {
      prompt: [enrichedPrompt, prepared.textContext, ...result.warnings.map((warning) => `[Input attachment unavailable: ${warning}]`)].filter(Boolean).join("\n\n"),
      attachments: prepared.fileAttachments,
      cleanup: result.cleanup,
    };
  } catch (error) {
    await result.cleanup();
    throw error;
  }
}
