import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SlackAdapter } from '../src/adapters/slack.js';
import { ConversationService, MemoryTurnJournal } from '../src/application/conversationService.js';
const event = (id:string,ts:string,thread?:string) => ({team_id:'T',event_id:id,event:{type:'app_mention',user:'U',channel:'C',text:'<@BOT> question',ts,...(thread?{thread_ts:thread}:{})}});
function setup(){
 const dir=mkdtempSync(join(tmpdir(),'slack-adapter-'));const journal=new MemoryTurnJournal();const service=new ConversationService(journal);const prompts:string[]=[],posts:Record<string,string>[]=[];let reads=0,authorized=true,extra=false,resets=0;let history:Record<string,unknown>[]=[{ts:'1700000001.000000',user:'U',text:'<@BOT> question',thread_ts:'1700000001.000000'},{ts:'1700000002.000000',user:'FRIEND',text:'unmentioned clarification',thread_ts:'1700000001.000000'}];
 const api={call:async(method:string,args?:Record<string,string>)=>{
  if(method==='conversations.info')return {ok:true,channel:{is_member:true}};
  if(method==='conversations.members')return {ok:true,members:authorized?['U','FRIEND','BOT',...(extra?['NEW']:[])]:['FRIEND','BOT']};
  if(method==='chat.postMessage'){posts.push(args!);return {ok:true,ts:'1900000009.000001'}};
  if(method==='conversations.replies'||method==='conversations.history'){reads++;return {ok:true,messages:history}}
  throw Error(method);
 }};
 const engine={sendMessage:async(_key:string,prompt:string)=>{prompts.push(prompt);return {content:'answer',attachments:[]}},resetSession:async()=>{resets++},shutdown:async()=>{}};
 const adapter=new SlackAdapter({teamId:'T',installationId:'i',botUserId:'BOT',channels:new Set(['C']),users:new Set(['U']),excludedAuthors:new Set(),stateDirectory:dir},api,api,engine,service);
 return {adapter,prompts,posts,journal,setHistory:(messages:Record<string,unknown>[])=>{history=messages},resets:()=>resets,changeAudience:()=>{extra=true},reads:()=>reads,revoke:()=>{authorized=false},close:async()=>{await service.shutdown();rmSync(dir,{recursive:true,force:true})}};
}
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
 const payload=event('recovery','1700000003.000000','1700000001.000000');const handle=await f.adapter.receive(payload);const delivered=await handle!.completion;
 assert.equal(delivered.state,'delivered');assert.ok(delivered.output?.audienceTag);
 f.journal.put({...delivered,state:'generated',receipt:undefined});f.changeAudience();
 const recovered=await f.adapter.receive(payload);assert.equal((await recovered!.completion).state,'interrupted');
 assert.equal(f.posts.length,1);assert.equal(f.prompts.length,1);
 }finally{await f.close()}
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
