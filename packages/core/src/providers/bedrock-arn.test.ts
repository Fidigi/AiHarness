import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BedrockProvider, type BedrockProviderConfig, type ChatResponse, type Message } from '../../dist/index.js';
import { bedrockText } from '../../../../tests/fixtures/bedrock-event-stream.js';
import { syntheticStsRole, syntheticStsXml } from '../../../../tests/fixtures/sts-web-identity.js';
const roots: string[] = [], known = 'anthropic.claude-opus-4-6-v1';
const arn = (region: string, partition = 'aws') => `arn:${partition}:bedrock:${region}:123456789012:inference-profile/us.${known}`;
const messages: Message[] = [{ id: 'u', role: 'user', timestamp: new Date(0), content: 'synthetic ARN' }, { id: 'a', role: 'assistant', timestamp: new Date(1), content: 'prior', provider: 'bedrock', model: known, api: 'bedrock-converse-stream', blocks: [{ type: 'reasoning', text: 'visible', thinkingSignature: 'must-not-borrow-native-signature' }] }];
const config: BedrockProviderConfig = { type: 'bedrock', accessKeyId: 'SYNTHETICARNKEY', secretAccessKey: 'SyntheticArnSecret', region: 'us-west-2' };
const json = () => Response.json({ output: { message: { role: 'assistant', content: [{ text: 'arn-ready' }] } }, stopReason: 'end_turn', usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } });
const reply = (url: unknown) => String(url).endsWith('/converse-stream') ? new Response(bedrockText('arn-ready', 'end_turn', { inputTokens: 8, outputTokens: 2, totalTokens: 10 }), { headers: { 'content-type': 'application/vnd.amazon.eventstream' } }) : json();
beforeEach(() => { for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_PROFILE']) vi.stubEnv(name, ''); });
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it('uses requested ARN region for native JSON/binary signing and partition endpoints without granting embedded native profile policy', async () => {
  const calls: Array<{ url: URL; headers: Headers; body: Record<string, unknown> }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init: RequestInit) => { calls.push({ url: new URL(String(url)), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) }); return reply(url); }));
  for (const [region, partition, suffix] of [['ap-southeast-2', 'aws', 'amazonaws.com'], ['cn-north-1', 'aws-cn', 'amazonaws.com.cn'], ['us-gov-west-1', 'aws-us-gov', 'amazonaws.com']]) {
    const model = arn(region, partition), provider = new BedrockProvider({ ...config, model: known });
    const first = await provider.chat(messages, { model }); let second: ChatResponse | undefined;
    await provider.streamChat(messages, () => {}, value => { second = value; }, undefined, { model });
    for (const result of [first, second]) { expect(result).toMatchObject({ model, content: 'arn-ready', usage: { totalTokens: 10 } }); expect(result?.usage?.costUsd).toBeUndefined(); }
    for (const [index, call] of calls.slice(-2).entries()) {
      expect(call.url.origin).toBe(`https://bedrock-runtime.${region}.${suffix}`);
      expect(call.url.pathname).toBe('/model/' + encodeURIComponent(model) + (index ? '/converse-stream' : '/converse'));
      expect(call.headers.get('authorization')).toContain('/' + region + '/bedrock/aws4_request');
      expect(JSON.stringify(call.body)).not.toContain('must-not-borrow-native-signature');
    }
  }
  expect(calls).toHaveLength(6);
});
it('uses an explicit standard endpoint region only below ARN and configured region, never for derived adapters', async () => {
  const calls: Array<{ url: string; headers: Headers }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init: RequestInit) => { calls.push({ url: String(url), headers: new Headers(init.headers) }); return reply(url); }));
  const credentials = { type: 'bedrock', accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey };
  for (const [host, endpointRegion] of [['bedrock-runtime.ap-southeast-2.amazonaws.com', 'ap-southeast-2'], ['bedrock-runtime-fips.us-gov-west-1.amazonaws.com', 'us-gov-west-1'], ['bedrock-runtime.cn-north-1.amazonaws.com.cn', 'cn-north-1']]) {
    const baseUrl = 'https://' + host + '/proxy', provider = new BedrockProvider({ ...credentials, model: known, baseUrl });
    await provider.chat(messages); await provider.streamChat(messages, () => {});
    for (const call of calls.slice(-2)) { expect(call.url).toContain(baseUrl + '/model/'); expect(call.headers.get('authorization')).toContain('/' + endpointRegion + '/bedrock/aws4_request'); }
    await new BedrockProvider({ ...config, model: known, baseUrl }).chat(messages);
    expect(calls.at(-1)?.headers.get('authorization')).toContain('/us-west-2/bedrock/aws4_request');
    await new BedrockProvider({ ...credentials, model: arn('eu-west-1'), baseUrl }).chat(messages);
    expect(calls.at(-1)?.url).toContain(baseUrl + '/model/'); expect(calls.at(-1)?.headers.get('authorization')).toContain('/eu-west-1/bedrock/aws4_request');
  }
  class Derived extends BedrockProvider {}
  await new Derived({ ...credentials, model: known, baseUrl: 'https://bedrock-runtime.ap-southeast-2.amazonaws.com' }).streamChat(messages, () => {});
  expect(calls.at(-1)?.headers.get('authorization')).toContain('/us-east-1/bedrock/aws4_request');
  expect(calls).toHaveLength(13);
});
it('preserves explicit endpoint and independent STS authority/cache while per-call ARN regions change', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-bedrock-arn-')); roots.push(root); const tokenFile = path.join(root, 'subject'); await writeFile(tokenFile, 'synthetic.arn.subject');
  const calls: Array<{ url: string; headers: Headers }> = [], endpoint = 'https://custom.synthetic/proxy';
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init: RequestInit) => { calls.push({ url: String(url), headers: new Headers(init.headers) }); return String(url) === 'https://sts.eu-west-1.amazonaws.com/' ? new Response(syntheticStsXml('ARNVENDED')) : reply(url); }));
  const provider = new BedrockProvider({ type: 'bedrock', model: arn('ap-southeast-2'), region: 'us-west-2', baseUrl: endpoint, bedrockWebIdentity: { tokenFile, roleArn: syntheticStsRole, region: 'eu-west-1' } });
  const first = await provider.chat(messages); let second: ChatResponse | undefined;
  await provider.streamChat(messages, () => {}, value => { second = value; }, undefined, { model: arn('cn-north-1', 'aws-cn') });
  expect(first.content).toBe('arn-ready'); expect(second?.content).toBe('arn-ready'); expect(calls).toHaveLength(3);
  expect(calls[0].url).toBe('https://sts.eu-west-1.amazonaws.com/'); expect(calls[0].headers.get('authorization')).toBeNull();
  for (const [index, region] of ['ap-southeast-2', 'cn-north-1'].entries()) {
    expect(calls[index + 1].url).toBe(endpoint + '/model/' + encodeURIComponent(arn(region, index ? 'aws-cn' : 'aws')) + (index ? '/converse-stream' : '/converse'));
    expect(calls[index + 1].headers.get('authorization')).toContain('Credential=ARNVENDED/');
    expect(calls[index + 1].headers.get('authorization')).toContain('/' + region + '/bedrock/aws4_request');
  }
});
it('preserves explicit Bearer/derived/non-Bedrock precedence and requires explicit specialized-partition ARN endpoints', async () => {
  const calls: Array<{ url: string; headers: Headers }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init: RequestInit) => { calls.push({ url: String(url), headers: new Headers(init.headers) }); return reply(url); }));
  const model = arn('ap-southeast-2'), endpoint = 'https://custom.synthetic/prefix';
  await new BedrockProvider({ ...config, apiKey: 'synthetic-arn-bearer', model, baseUrl: endpoint }).chat(messages);
  expect(calls[0].url).toBe(endpoint + '/model/' + encodeURIComponent(model) + '/converse'); expect(calls[0].headers.get('authorization')).toBe('Bearer synthetic-arn-bearer');
  class Derived extends BedrockProvider {}
  for (const provider of [new Derived({ ...config, model, baseUrl: endpoint }), new BedrockProvider({ ...config, model: 'arn:aws:iam::123456789012:role/Synthetic', baseUrl: endpoint })]) {
    await provider.chat(messages); await provider.streamChat(messages, () => {});
    const last = calls.slice(-2); expect(last[0].url).toBe(endpoint);
    for (const call of last) expect(call.headers.get('authorization')).toContain('/us-west-2/bedrock/aws4_request');
  }
  for (const [region, partition] of [['us-iso-east-1', 'aws-iso'], ['eusc-de-east-1', 'aws-eusc']]) {
    const unsupported = new BedrockProvider({ ...config, model: arn(region, partition) });
    await expect(unsupported.chat(messages)).rejects.toThrow(/Bedrock endpoint/u);
    const complete = vi.fn(), error = vi.fn(); await unsupported.streamChat(messages, () => {}, complete, error);
    expect(complete).not.toHaveBeenCalled(); expect(error).toHaveBeenCalledTimes(1);
    await new BedrockProvider({ ...config, model: arn(region, partition), baseUrl: endpoint }).chat(messages);
    expect(calls.at(-1)?.headers.get('authorization')).toContain('/' + region + '/bedrock/aws4_request');
  }
  expect(calls).toHaveLength(7);
});
