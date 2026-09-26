import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationService } from '../src/application/conversationService.js';
import { FileTurnJournal, MemoryTurnJournal } from '../src/application/conversationService.js';
import { TEXT_CAPABILITIES, sessionKey, eventKey, type IncomingTurn, type TrustedAdapterContext } from '../src/core/conversation.js';
const input = (eventId = 'e1', threadId = 't1'): IncomingTurn => ({ eventId, sourceMessageId: eventId, text: 'hello', receivedAt: new Date().toISOString(),
  actor: { platform: 'test', tenantId: 'tenant', userId: 'user' }, conversation: { platform: 'test', tenantId: 'tenant', installationId: 'i', channelId: 'c', threadId, kind: 'thread' } });
const host = (extra: Partial<TrustedAdapterContext> = {}): TrustedAdapterContext => ({ platform: 'test', tenantId: 'tenant', installationId: 'i', audience: 'shared', capabilities: TEXT_CAPABILITIES,
  authorize: async () => true, prepare: async i => ({ prompt: i.text }), generate: async p => ({ content: p.prompt, attachments: [] }), deliver: async () => ({ messageIds: ['m'] }), ...extra });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; };
test('concurrent duplicate events execute and deliver once', async () => {
  const s = new ConversationService(); let generated = 0, delivered = 0;
  const h = host({ generate: async () => { generated++; return { content: 'ok', attachments: [] }; }, deliver: async () => { delivered++; return { messageIds: ['m'] }; } });
  const [a,b] = await Promise.all([s.submit(input(),h),s.submit(input(),h)]);
  assert.equal(a.id,b.id); await Promise.all([a.completion,b.completion]); assert.equal(generated,1); assert.equal(delivered,1); await s.shutdown();
});
test('session keys isolate platform, tenant, installation, thread and actor audience', () => {
  const a = input(); const baseline = sessionKey(a,'shared');
  for(const field of ['platform','tenantId','installationId','channelId','threadId'] as const) assert.notEqual(sessionKey({ ...a, conversation: { ...a.conversation, [field]: 'other' } },'shared'),baseline);
  assert.notEqual(sessionKey(a,'individual'),baseline);
  assert.notEqual(sessionKey({ ...a, actor: { ...a.actor, userId: 'other' } },'individual'),sessionKey(a,'individual'));
});
test('forged identity and denied actors never prepare or generate', async () => {
  const s = new ConversationService(); let prepared = false;
  await assert.rejects(s.submit({ ...input(), actor: { ...input().actor, tenantId: 'forged' } },host()),/identity/);
  await assert.rejects(s.submit(input(),host({ authorize: async () => false, prepare: async () => { prepared=true; return { prompt: '' }; } })),/denied/);
  assert.equal(prepared,false); await s.shutdown();
});
test('same session serializes; independent sessions proceed; reset waits', async () => {
  const s = new ConversationService(), gate = deferred(), started = deferred(); const order:string[]=[];
  const first = await s.submit(input('1'),host({ generate: async () => { order.push('first'); started.resolve(); await gate.promise; return { content:'a',attachments:[] }; } }));
  await started.promise;
  const next = await s.submit(input('2'),host({ generate: async () => { order.push('second'); return { content:'b',attachments:[] }; } }));
  const reset = s.serial(sessionKey(input(),'shared'),async()=>{order.push('reset')});
  const other = await s.submit(input('3','other'),host()); await other.completion;
  assert.deepEqual(order,['first']); gate.resolve(); await Promise.all([first.completion,next.completion,reset]); assert.deepEqual(order,['first','second','reset']); await s.shutdown();
});
test('delivery failure remains uncertain and retries never regenerate', async () => {
  const journal = new MemoryTurnJournal(), s = new ConversationService(journal); let runs=0;
  const h = host({ generate: async()=>{runs++;return {content:'saved',attachments:[]};},deliver:async()=>{throw Error('ambiguous send');} });
  const a=await s.submit(input(),h); assert.equal((await a.completion).state,'interrupted');
  assert.equal(journal.get(a.id)?.output?.content,'saved'); await (await s.submit(input(),h)).completion; assert.equal(runs,1); await s.shutdown();
});
test('generated records recover delivery without provider execution',async()=>{
 const journal=new MemoryTurnJournal(); const i=input(); journal.put({id:eventKey(i),sessionKey:sessionKey(i,'shared'),input:i,state:'generated',updatedAt:'',output:{content:'saved',attachments:[]}});
 const s=new ConversationService(journal); let delivered=''; const h=await s.submit(i,host({generate:async()=>{throw Error('must not execute')},deliver:async o=>{delivered=o.content;return {messageIds:['m']}}}));
 assert.equal((await h.completion).state,'delivered');assert.equal(delivered,'saved');await s.shutdown();
});
test('durable ownership rejects second worker; restart flags ambiguous running turns',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'turn-journal-'));try{
 const j=new FileTurnJournal(dir);assert.throws(()=>new FileTurnJournal(dir));const i=input();j.put({id:eventKey(i),sessionKey:sessionKey(i,'shared'),input:i,state:'running',updatedAt:''});j.close();
 const restored=new FileTurnJournal(dir),s=new ConversationService(restored);assert.equal(restored.get(eventKey(i))?.state,'interrupted');await s.shutdown();
 }finally{rmSync(dir,{recursive:true,force:true})}
});
test('cancelled queued work and failed turns do not deadlock the queue',async()=>{
 const s=new ConversationService();const h=await s.submit(input(),host({generate:async()=>{throw Error('failure')}}));assert.equal((await h.completion).state,'failed');
 const next=await s.submit(input('2'),host());assert.equal((await next.completion).state,'delivered');await s.shutdown();
});
test('Discord reset acknowledges before waiting on an active session',async()=>{
 const { handleReset }=await import('../src/handlers/slash/reset.js');
 const { discordConversations }=await import('../src/adapters/discord/turn.js');
 const gate=deferred(),started=deferred();let deferredReply=false,reset=false,edited=false;
 const sessions={activeProviderDisplayName:()=> 'Fake',resetSession:async()=>{reset=true}};
 const service=discordConversations(sessions as never);
 const pending=service.serial('user:channel',async()=>{started.resolve();await gate.promise});await started.promise;
 const interaction={guildId:'guild',channelId:'channel',channel:{isThread:()=>false},user:{id:'user'},deferred:false,
  deferReply:async()=>{deferredReply=true;interaction.deferred=true},editReply:async()=>{edited=true},reply:async()=>{throw Error('must use editReply')}};
 const operation=handleReset(interaction as never,sessions as never);await Promise.resolve();await Promise.resolve();
 assert.equal(deferredReply,true);assert.equal(reset,false);gate.resolve();await Promise.all([pending,operation]);assert.equal(reset,true);assert.equal(edited,true);await service.shutdown();
});
