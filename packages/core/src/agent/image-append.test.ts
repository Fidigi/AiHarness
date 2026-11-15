import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { MockProvider, ExtensionRegistry, SessionManager, JsonlSessionStore, AgentRuntime, type Message, type ChatOptions, type ChatResponse, type PublishedModelMetadata, type MessageContentBlock } from '../index.js';
import { modelImagePng } from '../../../../tests/fixtures/model-image.mjs';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
type Image = Extract<MessageContentBlock, { type: 'image' }>;
const image = (width = 320): Image => ({ type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,' + modelImagePng(width, width / 2).toString('base64') });
const width = (block: Image) => Buffer.from(block.url.split(',')[1], 'base64').readUInt32BE(16);
class ImageProvider extends MockProvider {
  readonly calls: Message[][] = [];
  override getPublishedModels(): PublishedModelMetadata[] { return ['wide', 'small'].map((id, index) => ({ id, name: id,
    capabilities: { imageInput: true, reasoning: false, toolCalls: true }, inputLimits: { images: { resize: { maxWidth: index ? 16 : 64, maxHeight: index ? 16 : 64, maxBytes: 4718592, jpegQuality: 80 } } } })); }
  override async streamChat(messages: Message[], _chunk: (chunk: string) => void, complete?: (response?: ChatResponse) => void, _error?: (error: Error) => void, options?: ChatOptions): Promise<void> {
    this.calls.push(structuredClone(messages)); const last = messages.at(-1); complete?.({ content: last?.role === 'user' && last.content.includes('tool') ? '' : 'image-ready', model: options?.model ?? 'wide',
      ...(last?.role === 'user' && last.content.includes('tool') ? { toolCalls: [{ id: 'image-call-' + this.calls.length, name: 'image_probe', input: {} }] } : {}), usage: { promptTokens: 8, completionTokens: 2, totalTokens: 10 } });
  }
}
async function fixture(autoResize = true, toolImage: Image = image(360)) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-image-append-')); roots.push(root); const manager = new SessionManager({ store: new JsonlSessionStore(root) }), registry = new ExtensionRegistry(), provider = new ImageProvider({ type: 'mock' });
  await registry.load('synthetic-images', api => { api.registerTool({ name: 'image_probe', description: 'Synthetic image', execute: () => ({ content: 'tool-image', blocks: [toolImage] }) }); });
  const runtime = new AgentRuntime({ sessionManager: manager, extensionRegistry: registry, resolveProvider: () => provider, isProjectTrusted: () => true, resolveImageOptions: () => ({ autoResize }) }), session = await manager.create({ title: 'Image append' });
  const run = async (input: string, blocks?: MessageContentBlock[], model = 'wide') => { const started = await runtime.start({ sessionId: session.id, cwd: root, provider: 'mock', model, input, blocks }); expect((await runtime.wait(started.id))?.phase).toBe('completed'); };
  return { root, manager, registry, provider, runtime, session, run };
}
it('prepares new prompt and post-hook tool images once before journal append, retains exact prepared bytes across reload/model switch', async () => {
  const f = await fixture(), input = image(), replacement = image(480); await f.registry.load('image-hook', api => { api.before('before:tool:result', data => ({ result: { ...data.result, blocks: [replacement] } })); });
  await f.run('tool probe', [{ type: 'text', text: 'tool probe' }, input]); const messages = f.manager.get(f.session.id)!.messages, user = messages.find(row => row.role === 'user')!, tool = messages.find(row => row.role === 'tool')!;
  expect(tool.blocks, tool.content).toContainEqual(expect.objectContaining({ type: 'image' })); const userImage = user.blocks!.find(block => block.type === 'image') as Image, toolImage = tool.blocks!.find(block => block.type === 'image') as Image; expect(width(userImage)).toBe(64); expect(width(toolImage)).toBe(64); expect(user.content).toContain('original 320x160'); expect(tool.content).toContain('original 480x240'); expect(input.url).not.toBe(userImage.url); expect(width(replacement)).toBe(480); expect(f.provider.calls[1].filter(row => row.role === 'tool')[0].blocks).toContainEqual(toolImage);
  const journal = await readFile(path.join(f.root, f.session.id + '.jsonl'), 'utf8'); expect(journal).toContain(userImage.url); expect(journal).not.toContain(input.url); expect(journal).not.toContain(replacement.url); const loaded = new SessionManager({ store: new JsonlSessionStore(f.root) }); await loaded.loadAllSessions(); expect(loaded.get(f.session.id)?.messages.find(row => row.id === user.id)?.blocks).toContainEqual(userImage);
  await f.run('next prompt', [{ type: 'text', text: 'next prompt' }, input], 'small'); const last = f.manager.get(f.session.id)!.messages.filter(row => row.role === 'user').at(-1)!; expect(last.blocks, last.content).toContainEqual(expect.objectContaining({ type: 'image' })); expect(width(last.blocks!.find(block => block.type === 'image') as Image)).toBe(16); expect(f.provider.calls.at(-1)?.find(row => row.id === user.id)?.blocks).toContainEqual(userImage); expect(f.manager.get(f.session.id)!.messages.find(row => row.id === tool.id)?.blocks).toContainEqual(toolImage);
});
it('omits failed prompt images with a hint but preserves failed post-hook tool bytes and successful tool accounting', async () => {
  const malformed: Image = { type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,AA==' }, f = await fixture(true, malformed); await f.run('tool invalid', [{ type: 'text', text: 'tool invalid' }, malformed]); const messages = f.manager.get(f.session.id)!.messages, user = messages.find(row => row.role === 'user')!, tool = messages.find(row => row.role === 'tool')!; expect(user.blocks!.some(block => block.type === 'image')).toBe(false); expect(user.content).toContain('Image omitted'); expect(tool.blocks).toContainEqual(malformed); expect(tool.isError).toBe(false); expect(f.manager.get(f.session.id)?.usage?.totalTokens).toBe(20);
});
it('honors trusted autoResize=false for both new prompt and tool without rewriting their original data', async () => {
  const input = image(), toolInput = image(480), f = await fixture(false, toolInput); await f.run('tool raw', [{ type: 'text', text: 'tool raw' }, input]); const messages = f.manager.get(f.session.id)!.messages; expect(messages.find(row => row.role === 'user')?.blocks).toContainEqual(expect.objectContaining({ url: input.url })); expect(messages.find(row => row.role === 'tool')?.blocks).toContainEqual(expect.objectContaining({ url: toolInput.url })); expect(messages.filter(row => ['user', 'tool'].includes(row.role)).map(row => row.content).join('')).not.toContain('displayed at');
});
it('prepares queued follow-up images at their own first append without rewriting the initial image', async () => {
  const f = await fixture(), input = image(), next = image(480); let entered!: () => void, release!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; }), stream = f.provider.streamChat.bind(f.provider);
  f.provider.streamChat = async (...args: Parameters<typeof stream>) => { if (!f.provider.calls.length) { entered(); await gate; } return stream(...args); };
  const run = await f.runtime.start({ sessionId: f.session.id, cwd: f.root, provider: 'mock', model: 'wide', input: 'initial', blocks: [input] });
  try { await ready; f.runtime.enqueue(run.id, 'follow-up', 'queued', [next]); } finally { release(); }
  expect((await f.runtime.wait(run.id))?.phase).toBe('completed'); const users = f.manager.get(f.session.id)!.messages.filter(row => row.role === 'user'); expect(users).toHaveLength(2); expect(users[0].blocks).toContainEqual({ type: 'text', text: 'initial' }); expect(users[1].blocks).toContainEqual({ type: 'text', text: 'queued' }); for (const row of users) expect(width(row.blocks!.find(block => block.type === 'image') as Image)).toBe(64); expect(f.provider.calls.at(-1)?.find(row => row.id === users[0].id)?.blocks).toEqual(users[0].blocks); const journal = await readFile(path.join(f.root, f.session.id + '.jsonl'), 'utf8'); expect(journal).not.toContain(input.url); expect(journal).not.toContain(next.url);
});
it('withdraws pending image settings before append and never persists late image results after caller cancellation', async () => {
  const manager = new SessionManager(), registry = new ExtensionRegistry(), provider = new ImageProvider({ type: 'mock' }), controller = new AbortController(); let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; }); const runtime = new AgentRuntime({ sessionManager: manager, extensionRegistry: registry, resolveProvider: () => provider, isProjectTrusted: () => true, resolveImageOptions: () => { entered(); return new Promise(() => {}); } }), session = await manager.create({ title: 'Cancelled image' }); const started = await runtime.start({ sessionId: session.id, cwd: os.tmpdir(), provider: 'mock', model: 'wide', input: 'cancelled', blocks: [image()], signal: controller.signal }); await ready; controller.abort(); expect((await runtime.wait(started.id))?.phase).toBe('stopped'); expect(manager.get(session.id)?.messages).toEqual([]); expect(provider.calls).toEqual([]);
});
