export function discordResponseOptions(content, attachments = []) {
    return {
        content,
        files: attachments.map((attachment) => ({
            attachment: attachment.data,
            name: attachment.displayName,
        })),
    };
}
