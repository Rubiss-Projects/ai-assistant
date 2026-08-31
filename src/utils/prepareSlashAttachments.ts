import type { Attachment, Client } from "discord.js";
import { downloadFileAttachments, prepareDownloadedAttachments } from "./downloadAttachments.js";
import { resolveMessageLinks } from "./resolveMessageLinks.js";
import { enrichWithDiscordKnowledge } from "./discordKnowledge.js";
import type { ChatInputCommandInteraction } from "discord.js";

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
  attachments: Array<{ path: string; displayName?: string }>;
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
  );
  const result = await downloadFileAttachments([
    ...(directAttachment ? [directAttachment] : []),
    ...linkedAttachments,
  ]);

  try {
    const prepared = await prepareDownloadedAttachments(result.attachments);
    return {
      prompt: prepared.textContext
        ? `${enrichedPrompt}\n\n${prepared.textContext}`
        : enrichedPrompt,
      attachments: prepared.fileAttachments,
      cleanup: result.cleanup,
    };
  } catch (error) {
    await result.cleanup();
    throw error;
  }
}
