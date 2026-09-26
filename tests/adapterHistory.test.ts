import test from 'node:test';
import assert from 'node:assert/strict';
import { retrieveHistory, historyRange, historyBlock } from '../src/application/conversationService.js';
import { SlackHistory } from '../src/adapters/slack.js';
import type { IncomingTurn } from '../src/core/conversation.js';
import type { HistoryPort, HistoryMessage } from '../src/core/conversation.js';
const input:IncomingTurn={eventId:'e',sourceMessageId:'1700000009.000000',receivedAt:new Date(1700000009000).toISOString(),text:'hello',actor:{platform:'slack',tenantId:'T',userId:'U'},conversation:{platform:'slack',tenantId:'T',installationId:'i',channelId:'C',threadId:'1700000001.000000',kind:'thread'}};
const messages:HistoryMessage[]=Array.from({length:8},(_,i)=>({id:String(i+1),authorId:i===2?'U':'friend',text:'discussion '+i,timestamp:1700000000000+(i+1)*1000,position:'170000000'+(i+1)+'.000000'}));
function port():HistoryPort{return {page:async()=>({messages}),includeAuthor:()=>true,resolveMessageReference:()=>messages[1].position}}
test('thread root and unmentioned discussion are selected chronologically',async()=>{
 const r=await retrieveHistory(port(),input,input.conversation,{kind:'recent',count:3},new AbortController().signal,{messages:3,characters:8000,pages:10,scanned:1000},true);
 assert.deepEqual(r.messages.map(m=>m.id),['1','7','8']);
});
test('previous message means the actual preceding speaker message',async()=>{
 const r=await retrieveHistory(port(),input,input.conversation,{kind:'previous'},new AbortController().signal);assert.deepEqual(r.messages.map(m=>m.id),['4','5','6','7','8']);
});
test('failed pagination discards pages and marks unavailable',async()=>{
 let reads=0;const p=port();p.page=async()=>{if(reads++)throw Error('permission revoked');return {messages:messages.slice(0,2),cursor:'next'}};
 const r=await retrieveHistory(p,input,input.conversation,{kind:'recent',count:50},new AbortController().signal);assert.equal(r.coverage.status,'unavailable');assert.deepEqual(r.messages,[]);
});
test('budgets and author exclusions are disclosed; unsupported ranges rejected',async()=>{
 const p=port();p.includeAuthor=id=>id!=='friend';const r=await retrieveHistory(p,input,input.conversation,{kind:'recent',count:50},new AbortController().signal,{messages:50,characters:1,pages:1,scanned:100});assert.equal(r.coverage.status,'partial');assert.equal(r.coverage.excluded,7);
 assert.throws(()=>historyRange({range:'yesterday'},input,p,input.conversation));assert.throws(()=>historyRange({range:'relative_time',amount:2,unit:'years'},input,p,input.conversation));
});
test('Slack history binds channel, filters future and unrelated replies, checks permissions each page',async()=>{
 let calls=0;const api={call:async()=>{calls++;return {ok:true,messages:[{ts:'1700000002.000000',thread_ts:input.conversation.threadId,user:'friend',text:'eligible'},{ts:'1700000010.000000',thread_ts:input.conversation.threadId,user:'friend',text:'future'},{ts:'1700000003.000000',thread_ts:'other',user:'friend',text:'wrong thread'}]}}};
 const p=new SlackHistory(api,input.conversation,async()=>true);const r=await p.page(input.conversation,input.sourceMessageId!,undefined,new AbortController().signal);assert.equal(r.messages.length,1);
 await assert.rejects(p.page({...input.conversation,channelId:'OTHER'},input.sourceMessageId!,undefined,new AbortController().signal));assert.equal(calls,1);
});

test('host observations cover fetched records but are excluded from bounded provider context',async()=>{
 const r=await retrieveHistory(port(),input,input.conversation,{kind:'recent',count:3},new AbortController().signal,{messages:3,characters:8000,pages:10,scanned:1000},true);
 assert.equal(r.observed?.messages.length,8);assert.equal(r.observed?.complete,true);assert.equal(r.messages.length,3);
 assert.doesNotMatch(historyBlock(r),/discussion 3/);assert.doesNotMatch(historyBlock(r),/observed/);
});

test('recent Slack retrieval reaches the newest end beyond the scan limit and preserves root',async()=>{
 const root='1700000001.000000';const before='1700003000.000000';
 const all=Array.from({length:2001},(_,i)=>({ts:String(1700000001+i)+'.000000',thread_ts:root,user:'friend',text:'reply '+i}));
 let calls=0;
 const api={call:async(_method:string,args:Record<string,string>={})=>{calls++;const candidates=all.filter(m=>(!args.oldest||Number(m.ts)>Number(args.oldest))&&Number(m.ts)<Number(args.latest));return {ok:true,messages:candidates.slice(0,100),has_more:candidates.length>100,response_metadata:{next_cursor:candidates.length>100?'more':''}}}};
 const p=new SlackHistory(api,input.conversation,async()=>true);
 const r=await retrieveHistory(p,{...input,sourceMessageId:before},input.conversation,{kind:'recent',count:50},new AbortController().signal,{messages:50,characters:60000,pages:10,scanned:1000},true);
 assert.equal(r.messages[0].position,root);assert.equal(r.messages.at(-1)?.text,'reply 2000');
 assert.equal(r.messages.length,50);assert.ok(calls<=10);assert.equal(r.observed?.complete,false);assert.equal(r.coverage.status,'partial');
});
