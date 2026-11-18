import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
const fixture=fileURLToPath(new URL('./fixtures/summary-transcript-probe.mjs',import.meta.url));
const modes=['core-branch','sdk-auto','print-auto','json-auto','rpc-manual','rpc-auto','rpc-branch','regular','fullscreen','server-agent','server-auto'];
function run(mode:string,kind:string){
  return new Promise<{code:number|null;signal:NodeJS.Signals|null;stdout:string;stderr:string}>((resolve,reject)=>{
    const child=spawn(process.execPath,[fixture,mode,kind],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
    const timer=setTimeout(()=>child.kill('SIGKILL'),20_000);
    const capture=(text:string,channel:'stdout'|'stderr')=>{if(channel==='stdout')stdout+=text;else stderr+=text;if(Buffer.byteLength(stdout)+Buffer.byteLength(stderr)>1024*1024)child.kill('SIGKILL');};
    child.stdout.setEncoding('utf8').on('data',text=>capture(text,'stdout'));child.stderr.setEncoding('utf8').on('data',text=>capture(text,'stderr'));
    child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout,stderr});});
  });
}
for(const mode of modes)for(const kind of ['private','ordinary'])it(`${mode}/${kind} preserves useful summary context, not reasoning/replay/private data`,async()=>{
  const result=await run(mode,kind);expect(result,JSON.stringify(result)).toMatchObject({code:0,signal:null,stderr:''});
  expect(result.stdout.split('\n').filter(line=>line==='summary transcript OK')).toEqual(['summary transcript OK']);
  expect(result.stdout).not.toContain('PRIVATE_');if(!mode.startsWith('server-'))expect(result.stdout).toBe('summary transcript OK\n');
},25_000);
