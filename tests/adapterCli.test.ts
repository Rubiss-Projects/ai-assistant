import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
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
