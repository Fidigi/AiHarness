import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  BedrockProvider, prepareModelImage, resolveBedrockCredentialsEnvironment,
  type BedrockProviderConfig, type VertexProviderConfig, type AnthropicProviderConfig,
  type BedrockChatOptions, type AzureCompletionsChatOptions, type ResponsesChatOptions,
  type AnthropicChatOptions, type GoogleChatOptions,
} from '@ai-harness/core';
import { modelImagePng } from './model-image.mjs';
import { syntheticStsRole, syntheticStsXml, syntheticAssumeRoleXml } from './sts-web-identity.js';
const root = process.cwd(), installed = path.join(root, 'node_modules'), require = createRequire(import.meta.url);
assert.ok(fileURLToPath(import.meta.resolve('@ai-harness/core')).startsWith(path.join(installed, '@ai-harness', 'core') + path.sep));
for (const dependency of ['sharp', 'saxes']) assert.ok(require.resolve(dependency).startsWith(installed + path.sep));
const model = 'anthropic.claude-opus-4-6-v1', metadata = new BedrockProvider({ type: 'bedrock', model, apiKey: 'synthetic-image-metadata' });
const png = modelImagePng(2400, 1200), image = await prepareModelImage(metadata, model, { type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,' + png.toString('base64') }, { autoResize: true });
assert.equal(image.ok, true);
if (!image.ok) throw new Error('Installed native worker failed');
assert.equal(image.resized, true); assert.equal(image.image.width, 2000); assert.equal(image.image.height, 1000);
assert.match(image.image.url, /^data:image\/(?:png|jpeg);base64,/); assert.ok(image.image.size! > 0);
const auth = path.join(root, 'mod01-auth'), configFile = path.join(auth, 'config'), tokenFile = path.join(auth, 'subject');
await mkdir(auth, { recursive: true }); await writeFile(tokenFile, 'synthetic.installed.subject', { mode: 0o600 });
await writeFile(configFile, `[profile chosen]\nrole_arn=${syntheticStsRole}\nsource_profile=web\nregion=eu-west-1\nrole_session_name=installed-final\n[profile web]\nrole_arn=${syntheticStsRole}\nweb_identity_token_file=${tokenFile}\nrole_session_name=installed-leaf\nregion=ap-northeast-1\n`, { mode: 0o600 });
const env = { HOME: path.join(root, 'home'), AWS_PROFILE: 'chosen', AWS_CONFIG_FILE: configFile, AWS_REGION: 'us-west-2' };
const tool = { name: 'lookup', description: 'Synthetic installed tool', parameters: { type: 'object', properties: { value: { type: 'string' } } } };
const options: BedrockChatOptions = { tools: [{ ...tool, constrainedSampling: { type: 'json_schema', strict: 'require' } }], toolChoice: 'any' };
const azure: AzureCompletionsChatOptions = { tools: [{ ...tool, constrainedSampling: { type: 'json_schema', strict: 'prefer' } }], toolChoice: { type: 'function', function: { name: 'lookup' } } };
const responses: ResponsesChatOptions = { tools: [tool], toolChoice: 'required' }, anthropic: AnthropicChatOptions = { tools: [tool], toolChoice: 'any' }, google: GoogleChatOptions = { tools: [tool], toolChoice: 'none' };
const configs: [BedrockProviderConfig, BedrockProviderConfig, VertexProviderConfig, AnthropicProviderConfig] = [
  { type: 'bedrock', bedrockEcs: { fullUri: 'https://metadata.synthetic.test/credentials' } },
  { type: 'bedrock', bedrockWebIdentity: { roleArn: syntheticStsRole, tokenFile, roleSessionName: 'installed-web' } },
  { type: 'vertex', project: 'synthetic-project', location: 'global', vertexAdc: { credentialsFile: path.join(auth, 'adc.json') } },
  { type: 'anthropic', anthropicFederation: { federationRuleId: 'synthetic-rule', organizationId: 'synthetic-org', identityTokenFile: tokenFile } },
]; void configs; void azure; void responses; void anthropic; void google;
// @ts-expect-error profile source is a typed descriptor, never a profile-as-key string
const invalid: BedrockProviderConfig = { type: 'bedrock', bedrockProfile: 'chosen' }; void invalid;
let requests = 0, inference = 0;
globalThis.fetch = async (url, init) => {
  requests++; const target = String(url), headers = new Headers(init?.headers);
  if (target === 'https://sts.us-west-2.amazonaws.com/') {
    assert.equal(headers.get('authorization'), null); const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get('Action'), 'AssumeRoleWithWebIdentity'); assert.equal(body.get('WebIdentityToken'), 'synthetic.installed.subject');
    return new Response(syntheticStsXml('INSTALLEDLEAF'));
  }
  if (target === 'https://sts.eu-west-1.amazonaws.com/') {
    assert.ok(headers.get('authorization')?.includes('Credential=INSTALLEDLEAF/')); assert.equal(new URLSearchParams(String(init?.body)).get('Action'), 'AssumeRole');
    return new Response(syntheticAssumeRoleXml('INSTALLEDFINAL'));
  }
  assert.equal(target, 'https://bedrock-runtime.us-west-2.amazonaws.com/model/' + encodeURIComponent(model) + '/converse');
  assert.ok(headers.get('authorization')?.includes('Credential=INSTALLEDFINAL/'));
  const body = JSON.parse(String(init?.body)); assert.equal(body.toolConfig.tools[0].toolSpec.strict, true); assert.deepEqual(body.toolConfig.toolChoice, { any: {} }); inference++;
  return Response.json({ output: { message: { role: 'assistant', content: [{ text: 'installed-source-ready' }] } }, stopReason: 'end_turn', usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } });
};
const offline = await resolveBedrockCredentialsEnvironment(env, undefined, false); assert.ok(offline?.bedrockProfile); assert.equal(offline.bedrockProfile.allowNetwork, false);
await assert.rejects(new BedrockProvider({ ...offline, type: 'bedrock', model }).chat([]), { message: 'Bedrock profile authentication failed.' }); assert.equal(requests, 0);
const selected = await resolveBedrockCredentialsEnvironment(env); assert.ok(selected?.bedrockProfile);
const provider = new BedrockProvider({ ...selected, type: 'bedrock', model });
for (let i = 0; i < 2; i++) assert.equal((await provider.chat([{ id: 'u', timestamp: new Date(0), role: 'user', content: 'installed probe' }], options)).usage?.totalTokens, 10);
assert.equal(requests, 4); assert.equal(inference, 2);
console.log('MOD01_PACKAGED_PROVIDER_MEDIA_OK');
