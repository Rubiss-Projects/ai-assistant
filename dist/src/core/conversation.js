export const TEXT_CAPABILITIES = {
    threads: true,
    progress: true,
    attachments: false,
    history: false,
    messageLinks: false,
    memory: false,
    schedules: false,
    directMessages: false
};
export function validateIdentity(input, host) {
    const c = input.conversation;
    if (c.platform !== host.platform || c.tenantId !== host.tenantId || c.installationId !== host.installationId || input.actor.platform !== c.platform || input.actor.tenantId !== c.tenantId || ![
        c.platform,
        c.tenantId,
        c.installationId,
        c.channelId,
        input.actor.userId,
        input.eventId
    ].every((v)=>typeof v === 'string' && v.length > 0 && v.length <= 512) || c.kind === 'thread' && !c.threadId || ![
        'channel',
        'thread',
        'direct'
    ].includes(c.kind) || typeof input.text !== 'string' || input.text.length > 100_000 || !Number.isFinite(Date.parse(input.receivedAt))) {
        throw new Error('Invalid or mismatched conversation identity.');
    }
}
export function sessionKey(input, audience) {
    const c = input.conversation;
    return JSON.stringify([
        'conversation-v1',
        c.platform,
        c.tenantId,
        c.installationId,
        c.channelId,
        c.kind,
        c.threadId ?? null,
        audience,
        audience === 'individual' ? input.actor.userId : null
    ]);
}
export function eventKey(input) {
    const c = input.conversation;
    return JSON.stringify([
        c.platform,
        c.tenantId,
        c.installationId,
        input.eventId
    ]);
}
