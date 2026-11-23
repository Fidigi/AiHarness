import type { Request } from 'express';
import { externalOpenCommand, openExternalTarget } from '@ai-harness/core';

export interface WorkspaceFileManagerOptions {
  platform?: NodeJS.Platform;
  openDirectory?: (directory: string) => Promise<void>;
}

function hostName(host: string | undefined): string | undefined {
  const value = host?.trim().toLowerCase();
  if (!value) return undefined;
  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/u.exec(value);
  const plain = /^([^:]+)(?::(\d{1,5}))?$/u.exec(value);
  const match = bracketed ?? plain;
  if (!match) return undefined;
  const port = match[2];
  if (port !== undefined && Number(port) > 65_535) return undefined;
  return match[1];
}

export function isLoopbackAddress(value: string | undefined): boolean {
  if (!value) return false;
  const address = value.split('%')[0]?.toLowerCase();
  if (address === '::1') return true;
  const ipv4 = address?.startsWith('::ffff:') ? address.slice(7) : address;
  const octets = ipv4?.split('.');
  return octets?.length === 4
    && octets.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
    && Number(octets[0]) === 127;
}

export function isLoopbackFileManagerRequest(request: Request): boolean {
  const host = hostName(request.headers.host);
  return (host === 'localhost' || isLoopbackAddress(host))
    && isLoopbackAddress(request.socket.remoteAddress);
}

export function fileManagerAvailable(
  request: Request,
  platform: NodeJS.Platform = process.platform,
): { available: boolean; reason?: 'remote-request' | 'unsupported-platform' } {
  if (!isLoopbackFileManagerRequest(request)) return { available: false, reason: 'remote-request' };
  if (!externalOpenCommand('', 'directory', platform)) return { available: false, reason: 'unsupported-platform' };
  return { available: true };
}

export async function openWorkspaceDirectory(
  directory: string,
  options: WorkspaceFileManagerOptions = {},
): Promise<void> {
  if (options.openDirectory) {
    await options.openDirectory(directory);
    return;
  }
  await openExternalTarget(directory, 'directory', { platform: options.platform });
}
