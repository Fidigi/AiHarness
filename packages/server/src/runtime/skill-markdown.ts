import { lstat } from 'node:fs/promises';
import { atomicWriteStableFileWithReceipt, parseResourceMarkdown, readBoundedResourceText,
  type StableFilePublicationReceipt, type StableFilePublicationResult } from '@ai-harness/core';

const mutations = new Map<string, Promise<void>>();

/** Core's bounded UTF-8 reader strips the BOM for discovery. Recover it from
 * the stable byte length for editing, without a second untrusted body read. */
export async function readSkillMarkdown(filePath: string): Promise<string> {
  const before = await lstat(filePath);
  const source = await readBoundedResourceText(filePath);
  const after = await lstat(filePath);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw Object.assign(new Error('Skill changed while being read.'), { code: 'SKILL_CHANGED' });
  }
  const bytes = Buffer.byteLength(source);
  if (bytes === after.size) return source;
  if (bytes + 3 === after.size) return `\uFEFF${source}`;
  throw Object.assign(new Error('Invalid UTF-8 skill document.'), { code: 'INVALID_SKILL_DOCUMENT' });
}

export async function withSkillMutation<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const pending = (mutations.get(filePath) ?? Promise.resolve()).then(operation);
  const queued = pending.then(() => undefined, () => undefined);
  mutations.set(filePath, queued);
  void queued.then(() => { if (mutations.get(filePath) === queued) mutations.delete(filePath); });
  return pending;
}

/** Change only the invocation flag, retaining BOM, line endings, other keys and body bytes. */
export function skillInvocationMarkdown(source: string, name: string, enabled: boolean): string {
  const document = (() => {
    try { return parseResourceMarkdown(source); }
    catch { throw Object.assign(new Error('Invalid skill Markdown.'), { code: 'INVALID_SKILL_DOCUMENT' }); }
  })();
  const attributes = document.attributes;
  if (!document.frontmatter || attributes.name !== name || !document.body
    || !attributes.description || Buffer.byteLength(attributes.description) > 4096
    || (attributes.version && (Buffer.byteLength(attributes.version) > 128 || /[\u0000-\u001f\u007f]/.test(attributes.version)))
    || /[\u0000-\u001f\u007f]/.test(attributes.description)
    || (attributes['disable-model-invocation'] !== undefined
      && !['true', 'false'].includes(attributes['disable-model-invocation']))) {
    throw Object.assign(new Error('Invalid skill Markdown.'), { code: 'INVALID_SKILL_DOCUMENT' });
  }
  if ((attributes['disable-model-invocation'] !== 'true') === enabled) return source;
  const match = /^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---\r?\n)/.exec(source);
  if (!match) throw Object.assign(new Error('Invalid skill Markdown.'), { code: 'INVALID_SKILL_DOCUMENT' });
  const flag = `disable-model-invocation: ${!enabled}`;
  const frontmatter = /^[Dd][Ii][Ss][Aa][Bb][Ll][Ee]-[Mm][Oo][Dd][Ee][Ll]-[Ii][Nn][Vv][Oo][Cc][Aa][Tt][Ii][Oo][Nn]\s*:/m.test(match[2])
    ? match[2].replace(/^disable-model-invocation\s*:[^\r\n]*/im, flag)
    : `${match[2]}${match[1].endsWith('\r\n') ? '\r\n' : '\n'}${flag}`;
  return `${match[1]}${frontmatter}${match[3]}${source.slice(match[0].length)}`;
}

export async function writeSkillMarkdown(
  filePath: string, before: string, after: string, authorize: () => Promise<void>,
  expectedPublication?: StableFilePublicationReceipt,
): Promise<StableFilePublicationResult | undefined> {
  await authorize();
  if (before === after) return;
  const info = await lstat(filePath);
  return atomicWriteStableFileWithReceipt(filePath, after, { overwrite: true, maxBytes: 1024 * 1024,
    mode: info.mode & 0o777, expectedPublication,
    beforeCommit: async () => {
      await authorize();
      if (await readSkillMarkdown(filePath) !== before) {
        throw Object.assign(new Error('Skill changed before commit.'), { code: 'SKILL_CHANGED' });
      }
    },
  });
}
