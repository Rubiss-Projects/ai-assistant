import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
function run(dir:string,args:string[],stdin?:string){
 const code=`import('./src/adapters/cli/run.ts').then(m=>m.runCli(${JSON.stringify(args)})).catch(e=>{console.error(e.message);process.exitCode=1})`;
 return spawnSync(process.execPath,['--experimental-transform-types','--loader','./scripts/typescript-loader.mjs','--input-type=module','-e',code],{cwd:root,encoding:'utf8',input:stdin,timeout:10_000,env:{...process.env,AI_ASSISTANT_STATE_DIR:dir,DISCORD_TOKEN:'',PROVIDER:'fake'}});
}
test('CLI JSON stays parseable and persists selected sessions across invocations without Discord credentials',()=>{
 const dir=mkdtempSync(join(tmpdir(),'adapter-cli-'));try{
 const first=run(dir,['--provider','fake','--message','hello','--json']);assert.equal(first.status,0,first.stderr);assert.match(JSON.parse(first.stdout).content,/turn 1/);
 const second=run(dir,['--provider','fake','--message','again','--json']);assert.equal(second.status,0,second.stderr);assert.match(JSON.parse(second.stdout).content,/turn 2/);
 const isolated=run(dir,['--provider','fake','--thread','other','--message','hello','--json']);assert.match(JSON.parse(isolated.stdout).content,/turn 1/);
 const reset=run(dir,['--provider','fake','--reset','--json']);assert.equal(JSON.parse(reset.stdout).status,'reset');
 }finally{rmSync(dir,{recursive:true,force:true})}
});
test('CLI interactive input and invalid arguments have observable outcomes',()=>{
 const dir=mkdtempSync(join(tmpdir(),'adapter-cli-'));try{
 const interactive=run(dir,['--provider','fake'],'hello\n/quit\n');assert.equal(interactive.status,0,interactive.stderr);assert.match(interactive.stdout,/Fake response/);
 const invalid=run(dir,['--user','forged']);assert.notEqual(invalid.status,0);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
test('core/application imports do not depend on platform SDKs or adapters',()=>{
 for(const directory of ['src/core','src/application'])for(const file of readdirSync(join(root,directory))){if(!file.endsWith('.ts'))continue;const source=readFileSync(join(root,directory,file),'utf8');assert.doesNotMatch(source,/from ['"][^'"]*(?:discord\.js|@slack|adapters\/|sessionManager)/);}
});

for(const active of [false,true])test('CLI SIGTERM releases journal '+(active?'after active work settles':'while idle'),{timeout:10000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'adapter-cli-signal-'));
 const code=active
 ? "import('./src/adapters/cli/run.ts').then(m=>m.runCli(['--message','hello'],async()=>({sendMessage:async()=>{console.error('RUNNING');await new Promise(r=>setTimeout(r,300));return {content:'done',attachments:[]}},resetSession:async()=>{},shutdown:async()=>{}})))"
 : "import('./src/adapters/cli/run.ts').then(m=>m.runCli(['--provider','fake']))";
 const child=spawn(process.execPath,['--experimental-transform-types','--loader','./scripts/typescript-loader.mjs','--input-type=module','-e',code],{cwd:root,env:{...process.env,AI_ASSISTANT_STATE_DIR:dir,PROVIDER:'fake'},stdio:['pipe','pipe','pipe']});
 let output='';let sent=false;child.stderr.on('data',data=>{output+=data;if(!sent&&output.includes(active?'RUNNING':'Enter a message')){sent=true;child.kill('SIGTERM');}});
 try{
 const result=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.on('error',reject);child.on('exit',(code,signal)=>resolve({code,signal}));});
 assert.ok(sent,output);assert.equal(result.signal,null);assert.equal(result.code,143,output);
 assert.equal(existsSync(join(dir,'cli-turns','owner.lock')),false);
 const restarted=run(dir,['--provider','fake','--message','again','--json']);assert.equal(restarted.status,0,restarted.stderr);
 }finally{child.kill('SIGKILL');rmSync(dir,{recursive:true,force:true})}
});
test('engine context identity survives reopen and changes after reset',async()=>{
 const {createTextEngine}=await import('../src/composition/textEngine.js');const dir=mkdtempSync(join(tmpdir(),'engine-identity-'));
 try{
 const first=await createTextEngine('fake',dir);await first.sendMessage('thread','hello');const identity=first.contextIdentity!('thread');
 const second=await createTextEngine('fake',dir);assert.equal(second.contextIdentity!('thread'),identity);
 await second.sendMessage('thread','again');assert.equal(second.contextIdentity!('thread'),identity);
 await second.resetSession('thread');assert.notEqual(second.contextIdentity!('thread'),identity);
 await second.sendMessage('thread','fresh');assert.notEqual(second.contextIdentity!('thread'),identity);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
