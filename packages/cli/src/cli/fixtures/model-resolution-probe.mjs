import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [mode, scenario] = process.argv.slice(2);
assert.ok(['print', 'json', 'rpc'].includes(mode));
assert.ok(['one', 'two', 'none', 'qualified', 'native', 'pin', 'scope', 'warning', 'selected-warning', 'unmatched'].includes(scenario));
const root = await mkdtemp(path.join(os.tmpdir(), 'aih-model-resolution-'));
const cwd = path.join(root, 'work'), agent = path.join(root, 'agent'), calls = path.join(root, 'calls');
const model = 'shared-reason-model' + (scenario === 'native' ? ':high' : '');
const warning = 'Warning: A model scope entry could not be resolved.\n';
let child;
try {
  await mkdir(cwd); await mkdir(agent);
  const extension = path.join(root, 'providers.mjs');
  await writeFile(extension, `import { AiProvider } from ${JSON.stringify(import.meta.resolve('@ai-harness/core'))};
    import { appendFileSync } from 'node:fs';
    class PickProvider extends AiProvider {
      constructor(config, name) { super(config); this.name = name; }
      validateConfig() { return Boolean(this.config.apiKey); }
      async chat() { throw new Error('Unexpected nonstreaming request'); }
      async streamChat(_messages, chunk, complete, _error, options) {
        appendFileSync(${JSON.stringify(calls)}, JSON.stringify({provider:this.name, model:options.model, thinking:options.thinking})+'\\n');
        await chunk('Answer '+this.name); complete?.({content:'Answer '+this.name, model:options.model});
      }
    }
    export default api => { for (const name of ['pick-alpha','pick-beta']) api.registerProvider(name, {
      defaultConfig: { model:${JSON.stringify(model)} }, create:config=>new PickProvider(config,name)
    }); };`);
  const reference = scenario === 'qualified' ? 'pick-alpha/' + model : scenario === 'native' ? model
    : scenario === 'pin' ? 'pick-beta/' + model + ':low' : scenario === 'unmatched' ? 'nonexistent-reference' : scenario === 'one' ? model : 'shared';
  const selection = scenario === 'scope' ? ['--models', 'shared:low,missing-scope-entry,']
    : scenario === 'warning' ? ['--models', 'pick-alpha/' + model + ',missing-scope-entry,']
    : scenario === 'selected-warning' ? ['--model', 'pick-alpha/' + model, '--models', 'pick-beta/' + model + ',missing-scope-entry,'] : ['--model', reference];
  const denied = ['two', 'none', 'unmatched'].includes(scenario);
  const env = { PATH:process.env.PATH, HOME:path.join(root,'home'), AI_HARNESS_AGENT_DIR:agent, NO_COLOR:'1',
    AI_HARNESS_PICK_ALPHA_API_KEY: ['one','native','pin','none'].includes(scenario) ? '' : 'disposable-alpha',
    AI_HARNESS_PICK_BETA_API_KEY: scenario === 'none' ? '' : 'disposable-beta',
    // A saved/default provider must not quietly resolve an ambiguous --model.
    ...(scenario === 'two' ? { AI_HARNESS_DEFAULT_PROVIDER:'pick-alpha' } : {}),
  };
  const args = ['--offline','--approve','--no-extensions','-e',extension,'--no-context-files','--no-session',...selection,
    ...(mode === 'print' ? ['--print'] : ['--mode',mode]), ...(mode === 'rpc' ? [] : ['Question'])];
  const executable = process.env.AIH_MODEL_RESOLUTION_COMMAND ?? process.execPath;
  child = spawn(executable, process.env.AIH_MODEL_RESOLUTION_COMMAND ? args : [fileURLToPath(new URL('../../../dist/index.js', import.meta.url)),...args], {cwd,env,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='',buffer='',protocolError,turn=0;
  const records=[];
  child.stdout.setEncoding('utf8').on('data',text=>{
    stdout+=text; if(mode!=='rpc')return; buffer+=text;
    while(buffer.includes('\n')) {
      const index=buffer.indexOf('\n'),line=buffer.slice(0,index); buffer=buffer.slice(index+1);
      try {
        const record=JSON.parse(line);records.push(record);
        if(record.type==='agent_settled') child.stdin.write(JSON.stringify({type:'get_messages',id:'barrier-'+(++turn)})+'\n');
        if(record.type==='response'&&record.id==='barrier-1') {
          if(scenario==='scope') child.stdin.write(JSON.stringify({type:'cycle_model',id:'cycle'})+'\n'); else child.stdin.end();
        }
        if(record.type==='response'&&record.id==='cycle') {
          assert.equal(record.success,true);child.stdin.write(JSON.stringify({type:'prompt',id:'second',message:'Again'})+'\n');
        }
        if(record.type==='response'&&record.id==='barrier-2')child.stdin.end();
      } catch(error) {protocolError=error;child.stdin.end();}
    }
  });
  child.stderr.setEncoding('utf8').on('data',text=>{stderr+=text;});
  if(mode==='rpc') child.stdin.write(JSON.stringify({type:'prompt',id:'first',message:'Question'})+'\n'); else child.stdin.end();
  child.stdin.on('error',error=>{if(error.code!=='EPIPE')protocolError=error;});
  const timer=setTimeout(()=>child.kill('SIGKILL'),18_000);
  const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));}).finally(()=>clearTimeout(timer));
  assert.equal(exit.signal,null,JSON.stringify({exit,stdout,stderr}));assert.equal(protocolError,undefined);
  const invoked=(await readFile(calls,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;})).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  if(denied) {
    assert.equal(exit.code,mode==='rpc'?1:2,JSON.stringify({exit,stdout,stderr}));assert.equal(stdout,'');assert.deepEqual(invoked,[]);
    assert.match(stderr,scenario==='unmatched'?/not found/i:/ambiguous/i);
  } else {
    assert.equal(exit.code,0,JSON.stringify({exit,stdout,stderr}));
    assert.equal(stderr,['scope','warning','selected-warning'].includes(scenario)?warning:'');
    const first=['one','native','pin'].includes(scenario)?'pick-beta':'pick-alpha';
    assert.deepEqual(invoked.map(item=>item.provider),mode==='rpc'&&scenario==='scope'?[first,'pick-beta']:[first]);
    assert.ok(invoked.every(item=>item.model===model));
    if(['pin','scope'].includes(scenario)) assert.ok(invoked.every(item=>item.thinking==='low'));
    if(scenario==='native') assert.ok(invoked.every(item=>item.thinking!=='high'));
    if(mode==='print')assert.equal(stdout,'Answer '+first+'\n');
    else {
      const lines=stdout.trim().split('\n').map(line=>JSON.parse(line));assert.ok(lines.every(record=>typeof record.type==='string'));
      assert.equal(lines.filter(record=>record.type==='agent_settled').length,mode==='rpc'&&scenario==='scope'?2:1);
      if(mode==='json')assert.equal(lines[0].version,3);
    }
  }
  for(const secret of ['disposable-alpha','disposable-beta']) assert.ok(!(stdout+stderr).includes(secret));
  console.log('model resolution OK');
} finally { if(child&&child.exitCode===null)child.kill('SIGKILL');await rm(root,{recursive:true,force:true}); }
