import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SendMessageOptions } from '../src/providers/types.js';
import type { TurnOutput } from '../src/core/conversation.js';
import { SlackAdapter } from '../src/adapters/slack.js';
import { ConversationService, MemoryTurnJournal } from '../src/application/conversationService.js';
const event = (id:string,ts:string,thread?:string) => ({team_id:'T',event_id:id,event:{type:'app_mention',user:'U',channel:'C',text:'<@BOT> question',ts,...(thread?{thread_ts:thread}:{})}});
test('Slack service shutdown cancels active text-engine generation without delivering', { timeout: 2000 }, async () => {
 const f=setup(); let began!:()=>void;
 const started=new Promise<void>(resolve=>{began=resolve});
 let signal:AbortSignal|undefined;
 f.engine.sendMessage=async(_key,_prompt,_files,options)=>{
  signal=options?.signal; assert.ok(signal);
  return new Promise((_resolve,reject)=>{signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true});began()});
 };
 try {
  const turn=await f.adapter.receive(event('cancel','1700000003.000000','1700000001.000000'));
  await started; await f.service.shutdown();
  assert.equal(signal!.aborted,true);
  assert.equal((await turn!.completion).state,'cancelled');
  assert.equal(f.posts.length,0);
 } finally { await f.close(); }
});
function setup(){
 const dir=mkdtempSync(join(tmpdir(),'slack-adapter-'));const journal=new MemoryTurnJournal();const service=new ConversationService(journal);const prompts:string[]=[],posts:Record<string,string>[]=[];let identity="provider-a/session-1";let reads=0,authorized=true,extra=false,resets=0;let history:Record<string,unknown>[]=[{ts:'1700000001.000000',user:'U',text:'<@BOT> question',thread_ts:'1700000001.000000'},{ts:'1700000002.000000',user:'FRIEND',text:'unmentioned clarification',thread_ts:'1700000001.000000'}];
 let historyUnavailable = false, audienceFailureAt = 0, audienceCalls = 0;
 let historyStarted: (() => void) | undefined;
 let audienceStarted: (() => void) | undefined;
 const api={call:async(method:string,args?:Record<string,string>,signal?:AbortSignal)=>{
  if(method==='conversations.members' && audienceStarted) await new Promise<void>((_resolve,reject)=>{assert.ok(signal);signal.addEventListener('abort',()=>reject(signal.reason),{once:true});audienceStarted!();});
  if(method==='conversations.members' && ++audienceCalls === audienceFailureAt) throw new Error('Slack temporarily unavailable');
  if(method==='conversations.info')return {ok:true,channel:{is_member:true}};
  if(method==='conversations.members')return {ok:true,members:authorized?['U','FRIEND','BOT',...(extra?['NEW']:[])]:['FRIEND','BOT']};
  if(method==='chat.postMessage'){posts.push(args!);return {ok:true,ts:'1900000009.000001'}};
  if(method==='conversations.replies'||method==='conversations.history'){
   reads++;
   if(historyStarted) await new Promise<void>((_resolve,reject)=>{signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true});historyStarted!();});
   if(historyUnavailable)throw new Error('missing_scope');return {ok:true,messages:history}
  }
  throw Error(method);
 }};
 const engine={contextIdentity:()=>identity,sendMessage:async(_key:string,prompt:string,_files?:never,_options?:SendMessageOptions)=>{prompts.push(prompt);return {content:'answer',attachments:[]}},resetSession:async()=>{resets++},shutdown:async()=>{}};
 const excludedAuthors=new Set<string>();
 const adapter=new SlackAdapter({teamId:'T',installationId:'i',botUserId:'BOT',channels:new Set(['C']),users:new Set(['U']),excludedAuthors,stateDirectory:dir},api,api,engine,service);
 return {dir,adapter,engine,service,prompts,posts,journal,blockAudience:(started:()=>void)=>{audienceStarted=started},blockHistory:(started:()=>void)=>{historyStarted=started},failAudienceCheck:(offset:number)=>{audienceFailureAt=audienceCalls+offset},loseHistoryAccess:()=>{historyUnavailable=true},exclude:(id:string)=>excludedAuthors.add(id),changeIdentity:(value:string)=>{identity=value},setHistory:(messages:Record<string,unknown>[])=>{history=messages},resets:()=>resets,changeAudience:()=>{extra=true},reads:()=>reads,revoke:()=>{authorized=false},close:async()=>{await service.shutdown();rmSync(dir,{recursive:true,force:true})}};
}

test('Slack shutdown aborts audience membership retrieval before generation', { timeout: 2000 }, async () => {
 const f=setup();
 try {
  let began!:()=>void;
  const started=new Promise<void>(resolve=>{began=resolve});
  f.blockAudience(began);
  const turn=await f.adapter.receive(event('audience-cancel','1700000003.000000','1700000001.000000'));
  await started;
  await f.service.shutdown();
  assert.equal((await turn!.completion).state,'cancelled');
  assert.equal(f.prompts.length,0);
  assert.equal(f.posts.length,0);
 } finally {await f.close();}
});

test('Slack rebuilds retained discussion when native recovery happens after preparation', async () => {
 const f=setup();
 try {
  const root='1700000001.000000';
  await (await f.adapter.receive(event('before-recovery','1700000003.000000',root)))!.completion;
  f.setHistory([{ts:root,thread_ts:root,user:'U',text:'<@BOT> question'},{ts:'1700000002.000000',thread_ts:root,user:'FRIEND',text:'unmentioned clarification'},{ts:'1700000003.000000',thread_ts:root,user:'U',text:'<@BOT> question'}]);
  const generate=f.engine.sendMessage;
  f.engine.sendMessage=async(key,prompt,files,options)=>{
   assert.doesNotMatch(prompt,/unmentioned clarification/);
   assert.ok(options?.onSessionRecovery);
   const recovered=options.onSessionRecovery();
   assert.match(recovered,/unmentioned clarification/);
   assert.match(recovered,/Current speaker \(host-verified\)/);
   f.changeIdentity('provider-a/recovered');
   return generate(key,recovered,files,options);
  };
  const turn=await f.adapter.receive(event('native-recovery','1700000004.000000',root));
  assert.equal((await turn!.completion).state,'delivered');
  assert.match(f.prompts[1],/unmentioned clarification/);
 } finally {await f.close();}
});
test('Slack explicit thread mention includes unmentioned discussion and replies in thread',async()=>{
 const f=setup();try{const h=await f.adapter.receive(event('e','1700000003.000000','1700000001.000000'));assert.ok(h);assert.equal((await h.completion).state,'delivered');assert.match(f.prompts[0],/unmentioned clarification/);assert.equal(f.posts[0].thread_ts,'1700000001.000000');assert.ok(f.reads()>0);}finally{await f.close()}
});
test('plain reply, DM, other tenant, and bots never execute',async()=>{
 const f=setup();try{
 for(const payload of [{...event('e','1700000003.000000'),team_id:'OTHER'}, {...event('e','1700000003.000000'),event:{type:'message',user:'U',channel:'C',text:'plain reply',ts:'1700000003.000000'}},{...event('e','1700000003.000000'),event:{...(event('e','1700000003.000000').event),channel:'D1'}},{...event('e','1700000003.000000'),event:{...(event('e','1700000003.000000').event),bot_id:'B'}}]) assert.equal(await f.adapter.receive(payload),undefined);
 assert.equal(f.prompts.length,0);assert.equal(f.posts.length,0);
 }finally{await f.close()}
});
test('Slack duplicate events do not execute twice and revoked membership prevents delivery',async()=>{
 const f=setup();try{const payload=event('e','1700000003.000000','1700000001.000000');await (await f.adapter.receive(payload))!.completion;await (await f.adapter.receive(payload))!.completion;assert.equal(f.prompts.length,1);f.revoke();const denied=await f.adapter.receive(event('next','1700000004.000000','1700000001.000000'));assert.equal((await denied!.completion).state,'failed');assert.equal(f.prompts.length,1);assert.equal(f.posts.length,1);}finally{await f.close()}
});
test('recovered generated output cannot cross a changed audience',async()=>{
 const f=setup();try{
 const generate=f.engine.sendMessage;let output:TurnOutput|undefined;
 f.engine.sendMessage=async(...args)=>{const result=await generate(...args);output=result;return result};
 const payload=event('recovery','1700000003.000000','1700000001.000000');const handle=await f.adapter.receive(payload);const delivered=await handle!.completion;
 assert.equal(delivered.state,'delivered');assert.ok(output?.audienceTag);
 f.journal.put({...delivered,state:'generated',output,receipt:undefined});f.changeAudience();
 await f.adapter.recover();assert.equal(f.journal.get(delivered.id)?.state,'failed');
 assert.equal(f.posts.length,1);assert.equal(f.prompts.length,1);
 }finally{await f.close()}
});

for (const check of [1, 2]) test('Slack recovery preserves output when authorization check ' + check + ' is unavailable', async () => {
 const f = setup();
 try {
  const generate = f.engine.sendMessage;
  let output: TurnOutput | undefined;
  f.engine.sendMessage = async (...args) => { const result = await generate(...args); output = result; return result; };
  const handle = await f.adapter.receive(event('retry-recovery', '1700000003.000000', '1700000001.000000'));
  const delivered = await handle!.completion;
  assert.equal(delivered.state, 'delivered');
  assert.ok(output?.audienceTag);
  f.journal.put({ ...delivered, state: 'generated', output, receipt: undefined });
  f.failAudienceCheck(check);
  await f.adapter.recover();
  assert.equal(f.journal.get(delivered.id)?.state, 'generated');
  assert.equal(f.posts.length, 1);
  await f.adapter.recover();
  assert.equal(f.journal.get(delivered.id)?.state, 'delivered');
  assert.equal(f.journal.get(delivered.id)?.output, undefined);
  assert.equal(f.journal.get(delivered.id)?.error, undefined);
  assert.equal(f.posts.length, 2);
  assert.equal(f.prompts.length, 1);
 } finally { await f.close(); }
});

test('Slack resets retained provider history before continuing after history access is lost', async () => {
 const f = setup();
 try {
  const root = '1700000001.000000';
  await (await f.adapter.receive(event('history-first', '1700000003.000000', root)))!.completion;
  assert.match(f.prompts[0], /unmentioned clarification/);
  const resets = f.resets();
  f.loseHistoryAccess();
  const generate = f.engine.sendMessage;
  f.engine.sendMessage = async (...args) => {
   assert.equal(f.resets(), resets + 1, 'old context must be cleared before provider execution');
   return generate(...args);
  };
  const result = await (await f.adapter.receive(event('history-lost', '1700000004.000000', root)))!.completion;
  assert.equal(result.state, 'delivered');
  assert.match(f.prompts[1], /unavailable/);
  assert.doesNotMatch(f.prompts[1], /unmentioned clarification|Previously supplied records retained/);
 } finally { await f.close(); }
});

test('Slack cancellation during history retrieval preserves the existing provider session', { timeout: 2000 }, async () => {
 const f = setup();
 try {
  const root = '1700000001.000000';
  await (await f.adapter.receive(event('history-before-cancel', '1700000003.000000', root)))!.completion;
  const resets = f.resets();
  let began!: () => void;
  const fetching = new Promise<void>(resolve => { began = resolve; });
  f.blockHistory(began);
  const turn = await f.adapter.receive(event('history-cancel', '1700000004.000000', root));
  await fetching;
  await f.service.shutdown();
  assert.equal((await turn!.completion).state, 'cancelled');
  assert.equal(f.resets(), resets);
  assert.equal(f.prompts.length, 1);
 } finally { await f.close(); }
});

test('sampling a long thread does not erase retained context',async()=>{
 const f=setup();try{
 const root='1700000001.000000';const records=Array.from({length:70},(_,i)=>({ts:String(1700000001+i)+'.000000',thread_ts:root,user:'FRIEND',text:'discussion '+i}));
 f.setHistory(records);await (await f.adapter.receive(event('long-1','1700000100.000000',root)))!.completion;
 const resets=f.resets();f.setHistory([...records,{ts:'1700000100.000000',thread_ts:root,user:'U',text:'<@BOT> question'},{ts:'1700000101.000000',thread_ts:root,user:'FRIEND',text:'new detail'}]);
 await (await f.adapter.receive(event('long-2','1700000102.000000',root)))!.completion;
 assert.equal(f.resets(),resets);assert.match(f.prompts[1],/new detail/);
 }finally{await f.close()}
});
test('editing the original bot mention rebuilds the session with the observed revision',async()=>{
 const f=setup();try{
 await (await f.adapter.receive(event('original','1700000001.000000')))!.completion;const resets=f.resets();
 f.setHistory([{ts:'1700000001.000000',thread_ts:'1700000001.000000',user:'U',text:'<@BOT> corrected requirement',edited:{ts:'1700000002.000000'}}]);
 await (await f.adapter.receive(event('edited','1700000003.000000','1700000001.000000')))!.completion;
 assert.equal(f.resets(),resets+1);assert.match(f.prompts[1],/corrected requirement/);
 }finally{await f.close()}
});
test('a confirmed deletion rebuilds context while complete fetched records are separate from selection',async()=>{
 const f=setup();try{
 await (await f.adapter.receive(event('original','1700000001.000000')))!.completion;const resets=f.resets();f.setHistory([]);
 await (await f.adapter.receive(event('deleted','1700000003.000000','1700000001.000000')))!.completion;
 assert.equal(f.resets(),resets+1);
 }finally{await f.close()}
});

for(const identity of ['provider-b/session-1','provider-a/session-2'])test('Slack replays history when context identity becomes '+identity,async()=>{
 const f=setup();try{
 const root='1700000001.000000';
 await (await f.adapter.receive(event('identity-first','1700000003.000000',root)))!.completion;
 const history=[{ts:root,thread_ts:root,user:'U',text:'<@BOT> question'},{ts:'1700000002.000000',thread_ts:root,user:'FRIEND',text:'unmentioned clarification'},{ts:'1700000003.000000',thread_ts:root,user:'U',text:'<@BOT> question'}];f.setHistory(history);
 await (await f.adapter.receive(event('identity-same','1700000004.000000',root)))!.completion;
 assert.doesNotMatch(f.prompts[1],/unmentioned clarification/);
 const resets=f.resets();f.setHistory([...history,{ts:'1700000004.000000',thread_ts:root,user:'U',text:'<@BOT> question'}]);f.changeIdentity(identity);
 await (await f.adapter.receive(event('identity-changed','1700000005.000000',root)))!.completion;
 assert.equal(f.resets(),resets+1);assert.match(f.prompts[2],/unmentioned clarification/);
 }finally{await f.close()}
});

test('changed author exclusions invalidate earlier channel context outside the thread window',async()=>{
 const f=setup();try{
 f.setHistory([{ts:'1700000000.000000',user:'FRIEND',text:'old channel secret'}]);
 await (await f.adapter.receive(event('policy-first','1700000001.000000')))!.completion;
 assert.match(f.prompts[0],/old channel secret/);const resets=f.resets();
 f.exclude('FRIEND');f.setHistory([{ts:'1700000001.000000',thread_ts:'1700000001.000000',user:'U',text:'<@BOT> question'}]);
 await (await f.adapter.receive(event('policy-changed','1700000003.000000','1700000001.000000')))!.completion;
 assert.equal(f.resets(),resets+1);assert.doesNotMatch(f.prompts[1],/old channel secret/);
 f.setHistory(['1700000001.000000','1700000003.000000'].map(ts=>({ts,thread_ts:'1700000001.000000',user:'U',text:'<@BOT> question'})));
 await (await f.adapter.receive(event('policy-stable','1700000004.000000','1700000001.000000')))!.completion;
 assert.equal(f.resets(),resets+1);
 }finally{await f.close()}
});

test('shared Slack prompt includes verified attribution for the current request',async()=>{
 const f=setup();try{await (await f.adapter.receive(event('speaker','1700000003.000000','1700000001.000000')))!.completion;
 assert.match(f.prompts[0],/Current speaker \(host-verified\): {"platform":"slack","tenantId":"T","userId":"U"}/);
 }finally{await f.close()}
});

test('Slack compacts context at its metadata budget and resets before reusing provider history', async () => {
 const f=setup();
 try {
  const root='1700000001.000000';
  await (await f.adapter.receive(event('budget-first','1700000003.000000',root)))!.completion;
  const path=join(f.dir,readdirSync(f.dir).find(name=>name.endsWith('.json'))!);
  const state=JSON.parse(readFileSync(path,'utf8')) as {represented:string[];seen:Record<string,string>;positions:Record<string,string>;scopes:Record<string,string>};
  const entries=Object.keys(state.seen).length+Object.keys(state.positions).length+Object.keys(state.scopes).length;
  state.represented=Array.from({length:4000-entries},()=>state.represented[0]);
  writeFileSync(path,JSON.stringify(state));
  f.setHistory([{ts:root,thread_ts:root,user:'U',text:'<@BOT> question'},{ts:'1700000002.000000',thread_ts:root,user:'FRIEND',text:'unmentioned clarification'},{ts:'1700000003.000000',thread_ts:root,user:'U',text:'<@BOT> question'}]);
  const resets=f.resets();
  await (await f.adapter.receive(event('budget-compact','1700000004.000000',root)))!.completion;
  const compacted=JSON.parse(readFileSync(path,'utf8')) as {resetRequired:boolean;represented:string[]};
  assert.equal(compacted.resetRequired,true);
  assert.ok(compacted.represented.length<10);
  assert.equal(f.resets(),resets);
  await (await f.adapter.receive(event('budget-reset','1700000005.000000',root)))!.completion;
  assert.equal(f.resets(),resets+1);
  assert.match(f.prompts[2],/unmentioned clarification/);
 } finally {await f.close();}
});
