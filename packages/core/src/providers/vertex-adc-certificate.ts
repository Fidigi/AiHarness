import path from 'node:path';
import { homedir } from 'node:os';
import { createHash, createPrivateKey, X509Certificate } from 'node:crypto';
import type { CredentialRedactor } from './credentials.js';
export interface VertexCertificateEnvironment { cwd: string; configFile: string }
const failure = () => new Error('Vertex ADC authentication failed.');
export function vertexCertificateEnvironment(env: NodeJS.ProcessEnv): VertexCertificateEnvironment {
  const cwd = process.cwd(), home = env.HOME || homedir(), directory = env.CLOUDSDK_CONFIG || (process.platform === 'win32' ? path.join(env.APPDATA || home, 'gcloud') : path.join(home, '.config', 'gcloud'));
  return { cwd, configFile: env.GOOGLE_API_CERTIFICATE_CONFIG || path.join(directory, 'certificate_config.json') };
}
const location = (value: unknown, environment: VertexCertificateEnvironment): string => {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 4096 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw failure(); return path.resolve(environment.cwd, value);
};
/** Explicit readonly certificate source; caller supplies the existing bounded regular-file reader. */
export async function vertexCertificate(value: unknown, environment: VertexCertificateEnvironment, signal: AbortSignal, read: (file: string, signal: AbortSignal) => Promise<Buffer>, redactor?: Pick<CredentialRedactor, 'add'>) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure(); const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => !['use_default_certificate_config', 'certificate_config_location', 'trust_chain_path'].includes(key))
    || data.use_default_certificate_config !== undefined && typeof data.use_default_certificate_config !== 'boolean'
    || data.certificate_config_location !== undefined && typeof data.certificate_config_location !== 'string'
    || data.use_default_certificate_config === true && data.certificate_config_location !== undefined
    || data.use_default_certificate_config !== true && data.certificate_config_location === undefined) throw failure();
  const configFile = location(data.certificate_config_location ?? environment.configFile, environment), configBytes = await read(configFile, signal);
  const config: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(configBytes));
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw failure(); const configs = (config as Record<string, unknown>).cert_configs;
  if (!configs || typeof configs !== 'object' || Array.isArray(configs)) throw failure(); const workload = (configs as Record<string, unknown>).workload;
  if (!workload || typeof workload !== 'object' || Array.isArray(workload)) throw failure(); const fields = workload as Record<string, unknown>;
  const certFile = location(fields.cert_path, environment), keyFile = location(fields.key_path, environment), cert = await read(certFile, signal), key = await read(keyFile, signal);
  redactor?.add(new TextDecoder('utf-8', { fatal: true }).decode(key)); const leaf = new X509Certificate(cert), privateKey = createPrivateKey(key);
  const validFrom = Date.parse(leaf.validFrom), validTo = Date.parse(leaf.validTo);
  if (!leaf.checkPrivateKey(privateKey) || !Number.isFinite(validFrom) || !Number.isFinite(validTo)) throw failure();
  let chain = [leaf], trust: Buffer | undefined, trustFile: string | undefined;
  if (data.trust_chain_path !== undefined) {
    trustFile = location(data.trust_chain_path, environment); trust = await read(trustFile, signal);
    const blocks = new TextDecoder('utf-8', { fatal: true }).decode(trust).match(/-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/gu);
    if (!blocks?.length || blocks.length > 16) throw failure(); const certificates = blocks.map(block => new X509Certificate(block)), index = certificates.findIndex(cert => cert.raw.equals(leaf.raw));
    if (index > 0) throw failure(); chain = index === 0 ? certificates : [leaf, ...certificates];
  }
  const subject = JSON.stringify(chain.map(cert => cert.raw.toString('base64'))); if (Buffer.byteLength(subject) > 65536) throw failure(); redactor?.add(subject);
  for (const cert of chain) redactor?.add(cert.raw.toString('base64'));
  const fingerprint = createHash('sha256'); for (const bytes of [Buffer.from(configFile), configBytes, Buffer.from(certFile), cert, Buffer.from(keyFile), key, Buffer.from(trustFile ?? ''), trust ?? Buffer.alloc(0)]) fingerprint.update(String(bytes.length) + ':').update(bytes);
  signal.throwIfAborted(); return { cert, key, subject, validFrom, validTo, fingerprint: fingerprint.digest('hex') };
}
