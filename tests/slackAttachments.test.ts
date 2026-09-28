import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { SlackWebApi, type SlackApi } from '../src/adapters/slack.js';
import { prepareSlackFiles } from '../src/adapters/slackAttachments.js';

const url='https://files.slack.com/files-pri/T-F1/report.pdf';
const file={id:'F1',name:'report.pdf',mimetype:'application/pdf',url_private:url};
const signal=()=>new AbortController().signal;

test('SlackWebApi authenticates private file bytes with bot token and follows only trusted redirects',async t=>{
 const urls:string[]=[];
 t.mock.method(globalThis,'fetch',async(input:string|URL,options:RequestInit)=>{
  urls.push(String(input));assert.equal(new Headers(options.headers).get('authorization'),'Bearer test-bot');
  assert.equal(options.redirect,'manual');assert.ok(options.signal);
  return urls.length===1?new Response(null,{status:302,headers:{location:'/files-pri/T-F1/download/report.pdf'}}):new Response('%PDF-1.4');
 });
 const api=new SlackWebApi('test-bot');const r=await api.downloadFile(url,signal());assert.equal(await r.text(),'%PDF-1.4');assert.equal(urls.length,2);
});
for(const target of ['http://files.slack.com/files-pri/T-F1/file','https://files.slack.com.evil.test/files-pri/a','https://127.0.0.1/files-pri/a','https://files.slack.com:444/files-pri/a','https://token@files.slack.com/files-pri/a','https://files.slack.com/api/a']) {
 test('Slack refuses unsafe download target '+target,async t=>{
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('bad')});
  await assert.rejects(new SlackWebApi('secret').downloadFile(target,signal()),/Unsupported Slack/);assert.equal(calls,0);
 });
}
test('Slack refuses redirect credential leakage',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://example.com/steal'}})});
 await assert.rejects(new SlackWebApi('secret').downloadFile(url,signal()),/redirect was blocked/);assert.equal(calls,1);
});
test('Slack download errors do not reveal tokens or remote URLs',async t=>{
 t.mock.method(globalThis,'fetch',async()=>{throw Error('secret-token '+url)});
 await assert.rejects(new SlackWebApi('secret-token').downloadFile(url,signal()),error=>{assert.match(String(error),/files:read/);assert.doesNotMatch(String(error),/secret-token|files.slack.com/);return true});
});
test('Slack count limit, duplicate IDs, native binary bytes and cleanup',async()=>{
 let calls=0;const api:SlackApi={call:async()=>{throw Error('unexpected metadata lookup')},downloadFile:async()=>{calls++;return new Response('%PDF-1.4')}};
 const files=Array.from({length:7},(_,i)=>({...file,id:'F'+i,url_private:url+'?file='+i}));
 const result=await prepareSlackFiles(files,api,signal());
 try { assert.equal(calls,5);assert.equal(result.fileAttachments.length,5);assert.match(result.warnings.join(' '),/Only 5/);for(const f of result.fileAttachments){assert.equal(f.binary,true);assert.equal(readFileSync(f.path,'utf8'),'%PDF-1.4')} }
 finally {await result.cleanup()}
 assert.ok(result.fileAttachments.every(f=>!existsSync(f.path)));
 calls=0;const duplicate=await prepareSlackFiles([file,file],api,signal());try{assert.equal(calls,1)}finally{await duplicate.cleanup()}
});
test('Slack enforces declared, header and streamed byte limits and preserves successful files',async()=>{
 const old=process.env.AI_INPUT_ATTACHMENT_MAX_BYTES;process.env.AI_INPUT_ATTACHMENT_MAX_BYTES='8';
 let calls=0;const api:SlackApi={call:async()=>{throw Error('unexpected')},downloadFile:async()=>{
  calls++;if(calls===1)return new Response('short',{headers:{'content-length':'9'}});
  if(calls===2)return new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(9));c.close()}}));
  return new Response('%PDF-1');
 }};
 try {
  const result=await prepareSlackFiles([{...file,id:'F0',size:9},...['F1','F2','F3'].map(id=>({...file,id,url_private:url+'?file='+id}))],api,signal());
  try{assert.equal(calls,3);assert.equal(result.fileAttachments.length,1);assert.equal(result.warnings.length,3);assert.match(result.warnings.join(' '),/limit/)}finally{await result.cleanup()}
 }finally{if(old===undefined)delete process.env.AI_INPUT_ATTACHMENT_MAX_BYTES;else process.env.AI_INPUT_ATTACHMENT_MAX_BYTES=old}
});
test('Slack missing metadata, missing scope, external files and login pages warn instead of silently disappearing',async()=>{
 const api:SlackApi={call:async()=>{throw Error('missing_scope')},downloadFile:async()=>new Response('<html>login</html>',{headers:{'content-type':'text/html'}})};
 for(const files of [[{id:'F1'}],[{...file,is_external:true}],[file],null]){
  const result=await prepareSlackFiles(files,api,signal());try{assert.equal(result.fileAttachments.length,0);assert.ok(result.warnings.length)}finally{await result.cleanup()}
 }
});
