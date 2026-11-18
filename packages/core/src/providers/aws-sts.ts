import { SaxesParser } from 'saxes';
export type AwsStsSend = (url: string, init: RequestInit) => Promise<Response>;
export type AwsStsOperation = 'AssumeRole' | 'AssumeRoleWithWebIdentity';
const failure = () => new Error('Invalid STS credential response.');
export const validIamRoleArn = (value: unknown): value is string => typeof value === 'string' && Buffer.byteLength(value) <= 2048
  && /^arn:aws(?:-[a-z0-9-]+)?:iam::\d{12}:role\/(?:[\x21-\x7e]+\/)?[A-Za-z0-9+=,.@_-]{1,64}$/u.test(value);
export function awsStsEndpoint(region: string): string {
  if (typeof region !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)+-\d+$/u.test(region)) throw failure();
  const suffix = region.startsWith('cn-') ? 'amazonaws.com.cn' : region.startsWith('eusc-') ? 'amazonaws.eu' : region.startsWith('us-iso-') ? 'c2s.ic.gov' : region.startsWith('us-isob-') ? 'sc2s.sgov.gov' : region.startsWith('eu-isoe-') ? 'cloud.adc-e.uk' : region.startsWith('us-isof-') ? 'csp.hci.ic.gov' : 'amazonaws.com';
  return 'https://sts.' + region + '.' + suffix + '/';
}
const namespace = 'https://sts.amazonaws.com/doc/2011-06-15/', fields = new Set(['AccessKeyId', 'SecretAccessKey', 'SessionToken', 'Expiration']);
/** Same bounded scalar grammar for the two STS Query operations, not a general XML/endpoint authority. */
export async function readAwsStsCredentials(response: Response, signal: AbortSignal, operation: AwsStsOperation): Promise<Record<string, string>> {
  const root = operation + 'Response', result = root + '/' + operation + 'Result', credentialsPath = result + '/Credentials';
  const length = response.headers.get('content-length'); if (length !== null && (!/^(?:0|[1-9]\d*)$/u.test(length) || Number(length) > 262144)) { void response.body?.cancel().catch(() => undefined); throw failure(); }
  signal.throwIfAborted(); const reader = response.body?.getReader(); if (!reader) throw failure();
  const parser = new SaxesParser({ xmlns: true }), stack: string[] = [], values: Record<string, string> = Object.create(null); let nodes = 0, results = 0, credentials = 0, rootClosed = false;
  parser.on('doctype', () => { throw failure(); }); parser.on('processinginstruction', () => { throw failure(); }); parser.on('error', () => { throw failure(); });
  parser.on('xmldecl', declaration => { if (declaration.encoding && declaration.encoding.toLowerCase() !== 'utf-8') throw failure(); });
  parser.on('opentag', tag => {
    if (++nodes > 2048 || stack.length >= 8 || tag.uri !== namespace || !stack.length && tag.local !== root
      || stack.length >= 4 && stack.slice(0, 3).join('/') === credentialsPath && fields.has(stack[3])) throw failure();
    stack.push(tag.local); const current = stack.join('/'); if (current === result && ++results > 1 || current === credentialsPath && ++credentials > 1) throw failure();
    if (stack.length === 4 && stack.slice(0, 3).join('/') === credentialsPath && fields.has(tag.local)) { if (Object.hasOwn(values, tag.local)) throw failure(); values[tag.local] = ''; }
  });
  const text = (value: string) => { if (stack.length === 4 && stack.slice(0, 3).join('/') === credentialsPath && fields.has(stack[3])) values[stack[3]] += value; };
  parser.on('text', text); parser.on('cdata', text); parser.on('closetag', () => { stack.pop(); if (!stack.length) rootClosed = true; });
  const decoder = new TextDecoder('utf-8', { fatal: true }), aborted = Symbol('aborted'); let onAbort!: () => void, bytes = 0, complete = false;
  const cancellation = new Promise<typeof aborted>(resolve => { onAbort = () => resolve(aborted); if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); });
  try {
    while (true) { const item = await Promise.race([reader.read(), cancellation]); if (item === aborted) throw failure(); if (item.done) break; bytes += item.value.byteLength; if (bytes > 262144) throw failure(); parser.write(decoder.decode(item.value, { stream: true })); }
    parser.write(decoder.decode()).close(); signal.throwIfAborted(); if (!rootClosed || stack.length || results !== 1 || credentials !== 1 || Object.keys(values).length !== 4) throw failure();
    complete = true; return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.trim()]));
  } finally { signal.removeEventListener('abort', onAbort); if (!complete) void reader.cancel().catch(() => undefined); try { reader.releaseLock(); } catch { /* Hostile pending read need not settle. */ } }
}
