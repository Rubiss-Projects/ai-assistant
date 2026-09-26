import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { ConversationService, FileTurnJournal, historyBlock, historyRange, retrieveHistory } from '../application/conversationService.js';
import { TEXT_CAPABILITIES, sessionKey } from '../core/conversation.js';
import { createTextEngine } from '../composition/textEngine.js';
import { configuredSecurityMode } from '../common/providerSecurity.js';
export class SlackWebApi {
    token;
    constructor(token){
        this.token = token;
    }
    async call(method, args = {}, signal) {
        const response = await fetch('https://slack.com/api/' + method, {
            method: 'POST',
            headers: {
                authorization: 'Bearer ' + this.token,
                'content-type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams(args),
            signal: signal ? AbortSignal.any([
                signal,
                AbortSignal.timeout(10_000)
            ]) : AbortSignal.timeout(10_000)
        });
        if (response.status === 429) throw new Error('Slack rate limited; retry after ' + (response.headers.get('retry-after') ?? 'unknown') + ' seconds.');
        if (!response.ok) throw new Error('Slack request failed.');
        const data = await response.json();
        if (!data.ok) throw new Error('Slack API rejected request: ' + (data.error ?? 'unknown'));
        return data;
    }
}
export function slackPosition(value) {
    if (typeof value !== 'string' || !/^\d{10,}\.[0-9]{6}$/.test(value)) throw new Error('Invalid Slack message timestamp.');
    return value;
}
export function comparePosition(a, b) {
    const left = BigInt(slackPosition(a).replace('.', '')), right = BigInt(slackPosition(b).replace('.', ''));
    return left < right ? -1 : left > right ? 1 : 0;
}
export class SlackHistory {
    api;
    origin;
    authorize;
    excluded;
    constructor(api, origin, authorize, excluded = new Set()){
        this.api = api;
        this.origin = origin;
        this.authorize = authorize;
        this.excluded = excluded;
    }
    includeAuthor(id) {
        return !this.excluded.has(id);
    }
    resolveMessageReference(url, resource) {
        try {
            const parsed = new URL(url);
            const m = parsed.pathname.match(/^\/archives\/([^/]+)\/p(\d{10,})(\d{6})$/);
            if (parsed.protocol !== 'https:' || !/^[a-z0-9-]+\.slack\.com$/.test(parsed.hostname) || !m || m[1] !== resource.channelId) return;
            return m[2] + '.' + m[3];
        } catch  {
            return;
        }
    }
    async page(resource, before, cursor, signal) {
        if (resource.platform !== 'slack' || resource.tenantId !== this.origin.tenantId || resource.installationId !== this.origin.installationId || resource.channelId !== this.origin.channelId || resource.threadId && resource.threadId !== this.origin.threadId || !await this.authorize()) throw new Error('History access denied.');
        const args = {
            channel: resource.channelId,
            latest: before,
            inclusive: 'false',
            limit: '100',
            ...cursor ? {
                cursor
            } : {}
        };
        if (resource.threadId) args.ts = resource.threadId;
        const result = await this.api.call(resource.threadId ? 'conversations.replies' : 'conversations.history', args, signal);
        const messages = (Array.isArray(result.messages) ? result.messages : []).flatMap((raw)=>{
            if (typeof raw.ts !== 'string' || typeof raw.text !== 'string' || typeof raw.user !== 'string' || comparePosition(raw.ts, before) >= 0) return [];
            if (raw.subtype && ![
                'thread_broadcast',
                'bot_message'
            ].includes(String(raw.subtype))) return [];
            if (!resource.threadId && raw.thread_ts && raw.thread_ts !== raw.ts) return [];
            if (resource.threadId && raw.ts !== resource.threadId && raw.thread_ts !== resource.threadId) return [];
            return [
                {
                    id: JSON.stringify([
                        'slack',
                        resource.tenantId,
                        resource.channelId,
                        raw.ts
                    ]),
                    position: raw.ts,
                    authorId: raw.user,
                    text: raw.text,
                    timestamp: Number(raw.ts) * 1000,
                    threadId: typeof raw.thread_ts === 'string' ? raw.thread_ts : undefined,
                    revision: JSON.stringify(raw.edited ?? null),
                    url: 'https://app.slack.com/archives/' + resource.channelId + '/p' + raw.ts.replace('.', '')
                }
            ];
        });
        const next = result.response_metadata?.next_cursor || undefined;
        return {
            messages,
            cursor: next,
            truncated: Boolean(result.has_more && !next)
        };
    }
}
function fingerprint(message) {
    return createHash('sha256').update(JSON.stringify([
        message.authorId,
        message.text,
        message.revision ?? 'null'
    ])).digest('hex');
}
function historyScope(resource) {
    return JSON.stringify([
        resource.channelId,
        resource.threadId ?? null
    ]);
}
export class SlackAdapter {
    config;
    api;
    historyApi;
    engine;
    service;
    constructor(config, api, historyApi, engine, service){
        this.config = config;
        this.api = api;
        this.historyApi = historyApi;
        this.engine = engine;
        this.service = service;
        mkdirSync(config.stateDirectory, {
            recursive: true,
            mode: 0o700
        });
    }
    normalize(payload) {
        if (payload.team_id !== this.config.teamId || typeof payload.event_id !== 'string') return;
        const e = payload.event;
        if (!e || e.type !== 'app_mention' || e.bot_id || e.subtype || e.user === this.config.botUserId || typeof e.user !== 'string' || typeof e.channel !== 'string' || !this.config.channels.has(e.channel) || !this.config.users.has(e.user) || typeof e.text !== 'string' || !e.text.includes('<@' + this.config.botUserId + '>')) return;
        const ts = slackPosition(e.ts), thread = e.thread_ts ? slackPosition(e.thread_ts) : ts;
        return {
            eventId: payload.event_id,
            sourceMessageId: ts,
            text: e.text.split('<@' + this.config.botUserId + '>').join('').trim(),
            receivedAt: new Date(Number(ts) * 1000).toISOString(),
            actor: {
                platform: 'slack',
                tenantId: this.config.teamId,
                userId: e.user
            },
            conversation: {
                platform: 'slack',
                tenantId: this.config.teamId,
                installationId: this.config.installationId,
                channelId: e.channel,
                threadId: thread,
                kind: 'thread'
            }
        };
    }
    async audience(input) {
        const info = await this.api.call('conversations.info', {
            channel: input.conversation.channelId
        });
        const channel = info.channel;
        if (!channel || channel.is_im || channel.is_mpim || channel.is_ext_shared || channel.is_org_shared || !channel.is_member) throw new Error('Unsupported channel audience.');
        const members = new Set();
        let cursor;
        for(let page = 0; page < 20; page++){
            const result = await this.api.call('conversations.members', {
                channel: input.conversation.channelId,
                limit: '200',
                ...cursor ? {
                    cursor
                } : {}
            });
            for (const id of result.members ?? [])members.add(id);
            cursor = result.response_metadata?.next_cursor || undefined;
            if (!cursor) break;
        }
        if (cursor || !members.has(input.actor.userId) || !members.has(this.config.botUserId)) throw new Error('Cannot establish channel audience.');
        return createHash('sha256').update(JSON.stringify([
            ...members
        ].sort())).digest('hex');
    }
    stateFile(key) {
        return join(this.config.stateDirectory, createHash('sha256').update(key).digest('hex') + '.json');
    }
    load(key) {
        try {
            return JSON.parse(readFileSync(this.stateFile(key), 'utf8'));
        } catch (e) {
            if (e.code !== 'ENOENT') throw e;
            return {
                represented: [],
                seen: {},
                positions: {}
            };
        }
    }
    save(key, state) {
        const p = this.stateFile(key);
        writeFileSync(p + '.tmp', JSON.stringify(state), {
            mode: 0o600
        });
        renameSync(p + '.tmp', p);
    }
    async receive(payload) {
        const input = this.normalize(payload);
        if (!input) return;
        const key = sessionKey(input, 'shared');
        let audience;
        const authorized = async ()=>{
            try {
                const current = await this.audience(input);
                return audience === undefined || current === audience;
            } catch  {
                return false;
            }
        };
        const port = new SlackHistory(this.historyApi, input.conversation, authorized, this.config.excludedAuthors);
        return this.service.submit(input, {
            platform: 'slack',
            tenantId: this.config.teamId,
            installationId: this.config.installationId,
            audience: 'shared',
            capabilities: {
                ...TEXT_CAPABILITIES,
                history: true,
                progress: false
            },
            authorize: async (_i, stage)=>stage === 'ingress' ? true : authorized(),
            prepare: async (_i, session, signal)=>{
                audience = await this.audience(input);
                const state = this.load(session);
                state.represented ??= [];
                state.scopes ??= {};
                const resource = input.conversation.threadId === input.sourceMessageId ? {
                    ...input.conversation,
                    kind: 'channel',
                    threadId: undefined
                } : input.conversation;
                const result = await retrieveHistory(port, input, resource, {
                    kind: 'recent',
                    count: 50
                }, AbortSignal.any([
                    signal,
                    AbortSignal.timeout(15_000)
                ]), {
                    messages: 50,
                    characters: 8_000,
                    pages: 10,
                    scanned: 1000
                }, Boolean(resource.threadId));
                const fingerprints = Object.fromEntries(result.messages.map((m)=>[
                        m.id,
                        fingerprint(m)
                    ]));
                const observed = result.observed;
                const observedIds = new Set(observed?.messages.map((m)=>m.id));
                const changed = observed?.messages.some((m)=>state.seen[m.id] && state.seen[m.id] !== fingerprint(m) || state.represented.includes(m.position) && !state.seen[m.id]);
                const removed = observed?.complete && Object.entries(state.positions).some(([id, pos])=>state.scopes[id] === historyScope(resource) && comparePosition(pos, input.sourceMessageId) < 0 && !observedIds.has(id));
                if (state.audience !== audience || changed || removed) {
                    await this.engine.resetSession(session);
                    state.seen = {};
                    state.positions = {};
                    state.represented = [];
                    state.scopes = {};
                }
                const fresh = result.messages.filter((m)=>!state.seen[m.id] && !state.represented.includes(m.position));
                const next = {
                    represented: [
                        ...state.represented,
                        input.sourceMessageId
                    ],
                    audience,
                    seen: {
                        ...state.seen,
                        ...fingerprints
                    },
                    positions: {
                        ...state.positions,
                        ...Object.fromEntries(result.messages.map((m)=>[
                                m.id,
                                m.position
                            ]))
                    },
                    scopes: {
                        ...state.scopes,
                        ...Object.fromEntries(result.messages.map((m)=>[
                                m.id,
                                historyScope(resource)
                            ]))
                    }
                };
                const prompt = historyBlock({
                    ...result,
                    messages: fresh,
                    coverage: {
                        ...result.coverage,
                        included: fresh.length,
                        reasons: [
                            ...result.coverage.reasons,
                            ...fresh.length !== result.messages.length ? [
                                'Previously supplied records retained in this provider session.'
                            ] : []
                        ]
                    }
                }) + '\n\nCurrent request:\n' + input.text;
                return {
                    prompt,
                    next,
                    coverage: result.coverage
                };
            },
            generate: async (prepared, session, _signal, onProgress)=>{
                const response = await this.engine.sendMessage(session, prepared.prompt, undefined, {
                    transportContext: {
                        platform: 'slack',
                        history: true
                    },
                    onProgress,
                    resolveChannelHistory: async (args, signal)=>{
                        if (args.scope && ![
                            'channel',
                            'thread'
                        ].includes(String(args.scope))) throw new Error('Unsupported history scope.');
                        const resource = args.scope === 'channel' ? {
                            ...input.conversation,
                            kind: 'channel',
                            threadId: undefined
                        } : input.conversation;
                        const range = historyRange(args, input, port, resource);
                        const result = await retrieveHistory(port, input, resource, range, signal ? AbortSignal.any([
                            signal,
                            AbortSignal.timeout(15_000)
                        ]) : AbortSignal.timeout(15_000));
                        for (const message of result.messages){
                            prepared.next.seen[message.id] = fingerprint(message);
                            prepared.next.positions[message.id] = message.position;
                            prepared.next.scopes[message.id] = historyScope(resource);
                        }
                        return historyBlock(result);
                    }
                });
                const id = JSON.stringify([
                    'slack',
                    input.conversation.tenantId,
                    input.conversation.channelId,
                    input.sourceMessageId
                ]);
                prepared.next.positions[id] = input.sourceMessageId;
                const source = payload.event;
                prepared.next.seen[id] = fingerprint({
                    authorId: input.actor.userId,
                    text: String(source.text),
                    revision: JSON.stringify(source.edited ?? null)
                });
                prepared.next.scopes[id] = historyScope(input.conversation);
                this.save(session, prepared.next);
                response.audienceTag = audience;
                if (prepared.coverage.status === 'partial' || prepared.coverage.status === 'unavailable') response.content += '\n\n[Surrounding discussion context is ' + prepared.coverage.status + ': ' + prepared.coverage.reasons.join('; ') + ']';
                return response;
            },
            deliver: async (output, deliveryKey)=>{
                if (!output.audienceTag || output.audienceTag !== await this.audience(input)) throw new Error("Generated output audience changed; delivery denied.");
                const text = output.content + (output.attachments.length ? '\n[File delivery is unavailable in Slack.]' : '');
                const chars = Array.from(text || '(No text response)');
                const ids = [];
                const sent = [];
                for(let offset = 0; offset < chars.length; offset += 3000){
                    const result = await this.api.call('chat.postMessage', {
                        channel: input.conversation.channelId,
                        thread_ts: input.conversation.threadId,
                        text: chars.slice(offset, offset + 3000).join(''),
                        parse: 'none',
                        unfurl_links: 'false',
                        unfurl_media: 'false',
                        client_msg_id: createHash('sha256').update(deliveryKey + ':' + offset).digest('hex').slice(0, 32).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
                    });
                    if (typeof result.ts === 'string') {
                        ids.push(result.ts);
                        sent.push({
                            position: result.ts,
                            text: chars.slice(offset, offset + 3000).join('')
                        });
                    }
                }
                const state = this.load(key);
                state.represented = [
                    ...state.represented ?? [],
                    ...ids
                ];
                state.scopes ??= {};
                for (const message of sent){
                    const id = JSON.stringify([
                        'slack',
                        input.conversation.tenantId,
                        input.conversation.channelId,
                        message.position
                    ]);
                    state.seen[id] = fingerprint({
                        authorId: this.config.botUserId,
                        text: message.text
                    });
                    state.positions[id] = message.position;
                    state.scopes[id] = historyScope(input.conversation);
                }
                this.save(key, state);
                return {
                    messageIds: ids
                };
            }
        });
    }
}
function required(name) {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(name + ' is required.');
    return value;
}
export async function startSlack() {
    if (configuredSecurityMode() !== 'shared') throw new Error('Slack requires shared provider security mode.');
    const api = new SlackWebApi(required('SLACK_BOT_TOKEN'));
    const connections = new SlackWebApi(required('SLACK_APP_TOKEN'));
    const historyApi = process.env.SLACK_HISTORY_TOKEN ? new SlackWebApi(process.env.SLACK_HISTORY_TOKEN) : api;
    const teamId = required('SLACK_TEAM_ID');
    const auth = await api.call('auth.test');
    if (auth.team_id !== teamId || typeof auth.user_id !== 'string') throw new Error('Slack bot identity does not match configured workspace.');
    const historyAuth = await historyApi.call('auth.test');
    if (historyAuth.team_id !== teamId) throw new Error('Slack history credential belongs to a different workspace.');
    const list = (name)=>new Set(required(name).split(',').map((s)=>s.trim()).filter(Boolean));
    const channels = list('SLACK_ALLOWED_CHANNELS'), users = list('SLACK_ALLOWED_USERS');
    if (!channels.size || !users.size) throw new Error('Slack channel and user allowlists cannot be empty.');
    const directory = process.env.AI_ASSISTANT_STATE_DIR ?? join(homedir(), '.config', 'ai-assistant', 'adapters');
    const service = new ConversationService(new FileTurnJournal(join(directory, 'slack-turns')));
    let engine;
    try {
        engine = await createTextEngine(process.env.PROVIDER || 'copilot', join(directory, 'slack-provider-state'));
    } catch (error) {
        await service.shutdown();
        throw error;
    }
    const adapter = new SlackAdapter({
        teamId,
        installationId: process.env.SLACK_INSTALLATION_ID || 'default',
        botUserId: auth.user_id,
        channels,
        users,
        excludedAuthors: new Set((process.env.SLACK_EXCLUDED_CONTEXT_USERS ?? '').split(',').filter(Boolean)),
        stateDirectory: join(directory, 'slack-context')
    }, api, historyApi, engine, service);
    let stopped = false, socket, retry;
    let connecting = false;
    const reconnect = ()=>{
        if (!stopped && !retry) retry = setTimeout(()=>{
            retry = undefined;
            void connect();
        }, 5000);
    };
    async function connect() {
        if (stopped || connecting) return;
        connecting = true;
        try {
            const result = await connections.call('apps.connections.open');
            if (typeof result.url !== 'string') throw new Error('Missing Socket Mode URL.');
            const url = new URL(result.url);
            if (url.protocol !== 'wss:' || !url.hostname.endsWith('.slack.com')) throw new Error('Invalid Socket Mode endpoint.');
            if (stopped) return;
            const ws = new WebSocket(url);
            socket = ws;
            ws.addEventListener('message', (event)=>{
                void (async ()=>{
                    const envelope = JSON.parse(String(event.data));
                    if (envelope.type === 'disconnect') {
                        ws.close();
                        return;
                    }
                    if (typeof envelope.envelope_id !== 'string') return;
                    if (envelope.type !== 'events_api') {
                        ws.send(JSON.stringify({
                            envelope_id: envelope.envelope_id
                        }));
                        return;
                    }
                    const handle = await adapter.receive(envelope.payload);
                    ws.send(JSON.stringify({
                        envelope_id: envelope.envelope_id
                    }));
                    if (handle) void handle.completion.then((record)=>{
                        if (record.state !== 'delivered') console.error('[slack] Turn ' + record.state + ': ' + record.error);
                    });
                })().catch(()=>console.error('[slack] Event not accepted; source may retry.'));
            });
            ws.addEventListener('close', reconnect);
            ws.addEventListener('error', ()=>{
                ws.close();
                reconnect();
            });
        } catch  {
            console.error('[slack] Connection failed; retrying.');
            reconnect();
        } finally{
            connecting = false;
        }
    }
    await connect();
    return {
        async stop () {
            stopped = true;
            clearTimeout(retry);
            socket?.close();
            await service.shutdown();
            await engine.shutdown();
        }
    };
}
