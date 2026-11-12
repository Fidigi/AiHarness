import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

// Local-only issuer fixture: backdate NotBefore, without disabling TLS verification.
export async function createLocalTLSFixture(root) {
  const execute = promisify(execFile);
  await writeFile(root + '/index', '');
  await writeFile(root + '/serial', '01\n');
  await writeFile(root + '/ca.cnf', `[ca]\ndefault_ca=local\n[local]\nnew_certs_dir=${root}\ndatabase=${root}/index\nserial=${root}/serial\nprivate_key=${root}/key.pem\ndefault_md=sha256\npolicy=policy\nx509_extensions=extensions\n[policy]\ncommonName=supplied\n[extensions]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n`);
  await execute('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', root + '/key.pem', '-out', root + '/request.pem', '-subj', '/CN=localhost']);
  const from = new Date(Date.now() - 86400000).toISOString().replace(/\D/gu, '').slice(0, 14) + 'Z';
  await execute('openssl', ['ca', '-selfsign', '-batch', '-config', root + '/ca.cnf', '-in', root + '/request.pem', '-out', root + '/cert.pem', '-startdate', from, '-days', '1']);
  const cert = await readFile(root + '/cert.pem'), key = await readFile(root + '/key.pem');
  const certificate = new X509Certificate(cert);
  assert(Date.parse(certificate.validFrom) < Date.now() - 3600000);
  assert(Date.parse(certificate.validTo) > Date.now());
  return { key, cert };
}
