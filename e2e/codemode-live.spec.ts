import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MockProvider, type Message, type ChatResponse, type StreamChunkCallback } from '../packages/core/dist/index.js';
import { start, stop } from '../packages/server/dist/index.js';
import { createRuntimeServices } from '../packages/server/dist/runtime/services.js';
import { expect, test } from './fixtures/test-budget';

const codes = {
  timeout: 'store("rollback",true); /(a+)+$/.test("a".repeat(10000)+"!");',
  output: 'store("rollback",true); text("x".repeat(257));',
  stop: 'store("rollback",true); await tools.proof_hold({});',
};
const specialized = 'const result=await models.generateImages({model:"mock-image",prompt:"pixel"}); const classification=await models.classify({model:"native-code-model:classifier",input:"pixel?",labels:["yes","no"],images:result.images}); text(classification.label); text((await models.classifyQuestions({model:"native-code-model:classifier",state:{pixel:"unhooked"},questions:{pixel:{type:"boolean",prompt:"Pixel?"}},images:result.images})).answers.pixel.value); await image(result.images[0]); await tools.proof_effect({requested:true}); store("cursor",7);';
class NativeCodeProvider extends MockProvider {
  override getSpecializedModels() { return super.getSpecializedModels().map(model => model.type === 'classifier' ? { ...model, imageInput: true } : model); }
  override async chat(messages: Message[]): Promise<ChatResponse> {
    if (!['hooked-pixel', '{"pixel":true}'].includes(messages[0].content)
      || !messages[0].blocks?.some(block => block.type === 'image' && block.url.startsWith('data:image/png;base64,'))) throw Error('Missing classifier image/hook');
    return { content: messages[0].content === 'hooked-pixel' ? '{"label":"yes"}' : JSON.stringify({ answers: { pixel: {
      value: true, probabilities: [{ value: true, probability: 0.9 }, { value: false, probability: 0.1 }],
    } } }), usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4, costUsd: 0.002 } };
  }
  override async generateImages(...args: Parameters<MockProvider['generateImages']>) {
    return { ...await super.generateImages(...args), usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4, costUsd: 0.002 } };
  }
  override async streamChat(messages: Message[], _chunk: StreamChunkCallback, complete?: (response?: ChatResponse) => void) {
    const usage = { promptTokens: 2, completionTokens: 1, totalTokens: 3 };
    if (messages.some(message => message.role === 'tool')) { complete?.({ content: 'Native code finished', usage }); return; }
    const input = messages.find(message => message.role === 'user')!.content;
    const code = codes[input as keyof typeof codes] ?? specialized + (input === 'error' ? 'throw Error("controlled-native-error");' : 'return "pixel";');
    complete?.({ content: 'Running native code', usage, toolCalls: [{ id: 'native-script', name: 'codemode', input: { code } }] });
  }
}

// Unlike codemode.spec.ts (intercepted Settings/replay), use a disposable emitted
// server/static bundle, an explicitly host-configured provider, loaded hooks and a real worker.
for (const input of ['success', 'error', 'output', 'timeout', 'stop']) test(`native code ${input}: limits, images, cancellation and exact usage survive browser replay`, async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-code-browser-')), cwd = path.join(root, 'work');
  const effects = path.join(cwd, 'effects.jsonl'), extension = path.join(root, 'data/extensions/codemode-live.mjs');
  const names = ['AI_HARNESS_AUTH_TOKEN', 'AI_HARNESS_ADMIN_TOKEN'] as const, previous = names.map(name => process.env[name]);
  process.env.AI_HARNESS_AUTH_TOKEN = ''; process.env.AI_HARNESS_ADMIN_TOKEN = '';
  await mkdir(cwd); await mkdir(path.dirname(extension), { recursive: true });
  await writeFile(extension, `import { appendFile } from 'node:fs/promises';
    export default api=>{
      api.registerTool({name:'proof_effect',description:'Controlled fixture effect',exposure:'codemode',parameters:{type:'object'},execute:async input=>{
        if(!input.transformed)throw Error('Missing nested hook');await appendFile(${JSON.stringify(effects)},JSON.stringify(input)+'\\n');return {content:'effect completed'};
      }});
      api.registerTool({name:'proof_hold',description:'Cooperative cancellation fixture',exposure:'codemode',parameters:{type:'object'},execute:(_input,_context,signal)=>new Promise(resolve=>{
        const done=()=>resolve({content:'stopped'});if(signal.aborted)done();else signal.addEventListener('abort',done,{once:true});
      })});
      api.before('before:tool',data=>data.tool==='proof_effect'?{input:{transformed:true}}:undefined);
      api.before('before:model',data=>data.type==='classifier'?{request:'questions' in data.request?{...data.request,state:{pixel:true}}:{...data.request,input:'hooked-pixel'}}:undefined);
    };`);
  try {
    const server = await start({ port: 0, host: '127.0.0.1', defaultCwd: cwd, allowedRoots: [cwd], dataDir: path.join(root, 'data'),
      webRoot: path.resolve('packages/web/dist'), enableMockProvider: true,
      runtimeServicesFactory: async (proxy, options) => {
        const services = await createRuntimeServices(proxy, options);
        proxy.setCustomProvider('native-code-proof', new NativeCodeProvider({ type: 'mock', model: 'native-code-model' }));
        return services;
      } });
    const base = `http://127.0.0.1:${server.port}`;
    expect((await page.request.post(`${base}/api/workspaces/trust`, { data: { cwd, confirm: true } })).status()).toBe(200);
    const settings = { enabledTools: ['codemode', 'proof_effect', 'proof_hold'], toolPreset: 'default', powershellEnabled: false,
      codemodeEnabled: true, codemodeMode: 'only', codemodeLimits: { outputBytes: 256, timeoutMs: 1000, calls: 8, memoryBytes: 16 * 1024 * 1024 } };
    const saved = await page.request.patch(`${base}/api/tools`, { data: settings });
    expect(saved.ok(), await saved.text()).toBe(true); expect((await saved.json()).codemode.limits).toEqual(settings.codemodeLimits);
    expect((await page.request.patch(`${base}/api/tools`, { data: { ...settings, codemodeLimits: { calls: 65 } } })).status()).toBe(400);
    const started = await page.request.post(`${base}/api/agent/runs`, { data: { cwd, provider: 'native-code-proof', input, autoCompaction: false } });
    expect(started.status(), await started.text()).toBe(202);
    const { session, run } = await started.json() as { session: { id: string }; run: { id: string } };
    const stateUrl = `${base}/api/agent/sessions/${session.id}/state`;
    if (input === 'stop') {
      await expect.poll(async () => page.request.get(stateUrl).then(response => response.json()).then(state => state.run.activeTool?.nestedCalls?.[0]?.state)).toBe('running');
      expect((await page.request.post(`${base}/api/agent/runs/${run.id}/stop`)).status()).toBe(202);
    }
    await expect.poll(async () => page.request.get(stateUrl).then(response => response.json()).then(state => state.run.phase)).toBe(input === 'stop' ? 'stopped' : 'completed');
    const state = await page.request.get(stateUrl).then(response => response.json());
    const replay = await page.request.get(`${base}/api/sessions/${session.id}?messageLimit=80`);
    expect(replay.status(), await replay.text()).toBe(200);
    expect((await replay.json()).messages).toHaveLength(input === 'stop' ? 3 : 4);
    const tool = state.session.messages.find((message: { role: string }) => message.role === 'tool');
    expect(tool.isError).toBe(input !== 'success');
    expect(tool.metadata.codemode.store).toEqual(input === 'success' ? { cursor: 7 } : undefined);
    if (input === 'success' || input === 'error') {
      expect(tool.usage.totalTokens).toBe(12); expect(state.session.usage.totalTokens).toBe(18);
      expect(tool.metadata.codemode.nestedCalls.map((call: { kind: string }) => call.kind)).toEqual(['image', 'classifier', 'classifier', 'tool']);
      await page.goto(`${base}/chat/${session.id}?cwd=${encodeURIComponent(cwd)}`);
      await expect(page.getByRole('region', { name: 'Code mode · QuickJS' })).toContainText('yes');
      await expect(page.locator('.message.tool img')).toHaveCount(1);
      await expect.poll(() => page.locator('.message.tool img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
      await page.reload(); await expect(page.locator('.message.tool img')).toHaveCount(1); await expect(page.locator('.message.tool')).toHaveCount(1);
    } else expect(tool.content).toContain(input === 'timeout' ? 'deadline exceeded' : input === 'stop' ? 'interrupted' : 'output limit exceeded');
    // The error case still performs its external effect; only the guest store rolls back.
    const recorded = await readFile(effects, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    expect(recorded.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))).toEqual(['success', 'error'].includes(input) ? [{ transformed: true }] : []);
  } finally {
    await page.goto('about:blank').catch(() => undefined); await stop();
    for (const [index, name] of names.entries()) { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; }
    await rm(root, { recursive: true, force: true });
  }
});
