import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { Store } from '../src/store.js';
import { defaultConfig } from '../src/core.js';
import { createServer } from '../src/server.js';

test('launching a stopped existing instance starts its configured continuous run', async t => {
  const dir=mkdtempSync(join(tmpdir(),'boss-existing-'));
  const store=new Store(dir);
  store.saveConfig({...defaultConfig,setupComplete:true,autoRun:true});
  const runner={status:'stopped',task:null,start(){this.status='running';this.task={};},snapshot(){return{status:this.status,counts:{}};}};
  const server=createServer({store,runner,token:'existing-token',publicDir:join(import.meta.dirname,'../public')});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(dir,'instance.json'),JSON.stringify({pid:process.pid,url,token:'existing-token'}));
  const child=spawn(process.execPath,['src/main.js','--no-open'],{cwd:join(import.meta.dirname,'..'),env:{...process.env,BOSS_DATA_DIR:dir}});
  let errors='';child.stderr.on('data',d=>errors+=d);
  const code=await new Promise(r=>child.on('exit',r));
  assert.equal(code,0,errors);
  assert.equal(runner.status,'running');
});
