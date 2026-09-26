import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { ConversationService } from '../../application/conversationService.js';
import { FileTurnJournal } from '../../application/conversationService.js';
import { sessionKey, TEXT_CAPABILITIES } from '../../core/conversation.js';
import { createTextEngine } from '../../composition/textEngine.js';
export async function runCli(args = process.argv.slice(3)) {
    const opts = {};
    for(let i = 0; i < args.length; i++){
        const arg = args[i];
        if (arg === '--json' || arg === '--reset') {
            opts[arg.slice(2)] = 'true';
            continue;
        }
        if (![
            '--channel',
            '--thread',
            '--message',
            '--provider'
        ].includes(arg) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Use --channel, --thread, --message, --provider, --json or --reset.');
        opts[arg.slice(2)] = args[++i];
    }
    if (opts.json && !opts.message && !opts.reset) throw new Error('--json requires --message or --reset.');
    const originalLog = console.log;
    if (opts.json) console.log = (...values)=>console.error(...values);
    const directory = process.env.AI_ASSISTANT_STATE_DIR ?? join(homedir(), '.config', 'ai-assistant', 'adapters');
    const service = new ConversationService(new FileTurnJournal(join(directory, 'cli-turns')));
    let engine;
    let cancel;
    let interrupted = false;
    const onSignal = ()=>{
        interrupted = true;
        cancel?.();
        console.error('Cancellation requested; waiting for the active provider to stop.');
    };
    process.on('SIGINT', onSignal);
    const actor = {
        platform: 'cli',
        tenantId: 'local',
        userId: process.env.AI_ASSISTANT_CLI_USER || userInfo().username
    };
    const input = (text)=>({
            eventId: randomUUID(),
            text,
            actor,
            receivedAt: new Date().toISOString(),
            conversation: {
                platform: 'cli',
                tenantId: 'local',
                installationId: 'local',
                channelId: opts.channel || 'local',
                threadId: opts.thread || 'default',
                kind: 'thread'
            }
        });
    const print = (data)=>process.stdout.write((opts.json ? JSON.stringify(data) : String(data)) + '\n');
    try {
        engine = await createTextEngine(opts.provider || process.env.PROVIDER || 'copilot', join(directory, 'fake'));
        const reset = async ()=>{
            if (process.env.AI_ASSISTANT_CLI_ALLOW_RESET === 'false') throw new Error('Reset is disabled by local policy.');
            await service.serial(sessionKey(input(''), 'individual'), ()=>engine.resetSession(sessionKey(input(''), 'individual')));
            print(opts.json ? {
                status: 'reset'
            } : 'Session reset.');
        };
        const turn = async (text)=>{
            const handle = await service.submit(input(text), {
                platform: 'cli',
                tenantId: 'local',
                installationId: 'local',
                capabilities: TEXT_CAPABILITIES,
                audience: 'individual',
                authorize: async (i)=>i.actor.userId === actor.userId,
                prepare: async (i)=>({
                        prompt: i.text
                    }),
                generate: (p, key, _signal, onProgress)=>engine.sendMessage(key, p.prompt, undefined, {
                        transportContext: {
                            platform: 'cli',
                            history: false
                        },
                        onProgress
                    }),
                progress: async (p)=>{
                    console.error(p.message);
                },
                deliver: async (output)=>{
                    print(opts.json ? {
                        status: 'delivered',
                        content: output.content,
                        unsupportedAttachments: output.attachments.length
                    } : output.content + (output.attachments.length ? '\n[File delivery unavailable in CLI.]' : ''));
                    return {
                        messageIds: []
                    };
                }
            });
            cancel = handle.cancel;
            const result = await handle.completion;
            cancel = undefined;
            if (result.state !== 'delivered') {
                print(opts.json ? {
                    status: result.state,
                    error: result.error
                } : result.error);
                process.exitCode = interrupted ? 130 : 1;
            }
        };
        if (opts.reset) await reset();
        if (opts.message) await turn(opts.message);
        else if (!opts.reset) {
            const terminal = createInterface({
                input: process.stdin,
                output: process.stderr,
                terminal: process.stdin.isTTY
            });
            console.error('Enter a message, /reset or /quit.');
            try {
                for await (const line of terminal){
                    if (line === '/quit' || interrupted) break;
                    if (line === '/reset') await reset();
                    else if (line.trim()) await turn(line);
                }
            } finally{
                terminal.close();
            }
        }
    } finally{
        process.off('SIGINT', onSignal);
        await service.shutdown();
        await engine?.shutdown();
        console.log = originalLog;
    }
}
