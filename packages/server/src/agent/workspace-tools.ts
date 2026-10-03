import { spawn } from 'node:child_process';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExtensionRegistry, ExtensionRuntimeContext, WorkspaceManager } from '@ai-harness/core';

const MAX_FILE_BYTES = 1_000_000;
const MAX_TOOL_OUTPUT = 200_000;

function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error("Paramètres d'outil invalides.");
  return input as Record<string, unknown>;
}

function requiredString(input: Record<string, unknown>, key: string, max = 20_000): string {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Paramètre ${key} invalide.`);
  return value;
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function workspacePath(
  manager: WorkspaceManager,
  context: ExtensionRuntimeContext,
  input: string,
  options: { mustExist?: boolean; kind?: 'file' | 'directory' | 'any' } = {},
): Promise<string> {
  if (!context.cwd) throw new Error('Workspace absent du contexte outil.');
  const cwd = await manager.resolve(context.cwd, { kind: 'directory' });
  const resolved = await manager.resolve(input, {
    base: cwd,
    mustExist: options.mustExist,
    kind: options.kind,
  });
  if (!inside(cwd, resolved)) throw new Error('Chemin hors du workspace actif.');
  return resolved;
}

function requireTrust(context: ExtensionRuntimeContext): void {
  if (!context.projectTrusted) throw new Error("Le workspace doit être approuvé avant cette action.");
}

async function runCommand(
  command: string,
  cwd: string,
  signal?: AbortSignal,
  shell: 'default' | 'powershell' = 'default',
): Promise<{ output: string; exitCode: number; durationMs: number; truncated: boolean }> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const powershell = shell === 'powershell' || process.platform === 'win32';
    const child = spawn(powershell ? 'powershell.exe' : '/bin/sh',
      powershell ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] : ['-lc', command], {
        cwd,
        env: { ...process.env, AI_HARNESS_AGENT: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    let output = '';
    let truncated = false;
    const append = (chunk: Buffer): void => {
      if (output.length >= MAX_TOOL_OUTPUT) {
        truncated = true;
        return;
      }
      const text = chunk.toString('utf8');
      const room = MAX_TOOL_OUTPUT - output.length;
      output += text.slice(0, room);
      if (text.length > room) truncated = true;
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timeout = setTimeout(() => child.kill('SIGTERM'), 120_000);
    const abort = (): void => { child.kill('SIGTERM'); };
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', error => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) {
        reject(new Error('Commande annulée.'));
        return;
      }
      resolve({
        output: `${output}${truncated ? '\n[Sortie tronquée]' : ''}`,
        exitCode: code ?? 1,
        durationMs: Date.now() - startedAt,
        truncated,
      });
    });
  });
}

/** Register workspace-scoped tools. Every path is canonicalized at execution time. */
export async function registerWorkspaceTools(
  registry: ExtensionRegistry,
  workspaceManager: WorkspaceManager,
): Promise<void> {
  await registry.load('server:workspace-tools', api => {
    api.registerTool({
      name: 'list_files',
      description: 'Lister les entrées d’un dossier du workspace.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Chemin relatif au workspace.' } },
      },
      execute: async (raw, context) => {
        const input = objectInput(raw);
        const directory = await workspacePath(workspaceManager, context, typeof input.path === 'string' ? input.path : '.', {
          kind: 'directory',
        });
        const entries = await readdir(directory, { withFileTypes: true });
        return {
          content: entries
            .sort((left, right) => left.name.localeCompare(right.name))
            .map(entry => `${entry.isDirectory() ? 'd' : 'f'} ${entry.name}`)
            .join('\n'),
        };
      },
    });

    api.registerTool({
      name: 'read_file',
      description: 'Lire un fichier texte du workspace.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      execute: async (raw, context) => {
        const input = objectInput(raw);
        const filePath = await workspacePath(workspaceManager, context, requiredString(input, 'path'), { kind: 'file' });
        const info = await stat(filePath);
        if (info.size > MAX_FILE_BYTES) throw new Error('Fichier trop volumineux pour un outil de lecture.');
        return { content: await readFile(filePath, 'utf8') };
      },
    });

    api.registerTool({
      name: 'write_file',
      description: 'Écrire un fichier texte dans un workspace approuvé.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
      execute: async (raw, context) => {
        requireTrust(context);
        const input = objectInput(raw);
        const content = requiredString(input, 'content', MAX_FILE_BYTES);
        const filePath = await workspacePath(workspaceManager, context, requiredString(input, 'path'), {
          mustExist: false,
          kind: 'file',
        });
        await writeFile(filePath, content, { encoding: 'utf8', flag: 'w' });
        return { content: `Fichier écrit : ${path.relative(context.cwd!, filePath)}` };
      },
    });

    api.registerTool({
      name: 'git_status',
      description: 'Afficher le statut Git court du workspace.',
      parameters: { type: 'object', properties: {} },
      execute: async (_raw, context, signal) => {
        if (!context.cwd) throw new Error('Workspace absent du contexte outil.');
        const cwd = await workspacePath(workspaceManager, context, '.', { kind: 'directory' });
        const result = await runCommand('git status --short --branch', cwd, signal);
        return { content: result.output || '(aucun changement)', isError: result.exitCode !== 0, details: result };
      },
    });

    api.registerTool({
      name: 'git_diff',
      description: 'Afficher le diff Git sans couleur.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
      },
      execute: async (raw, context, signal) => {
        const input = objectInput(raw);
        const cwd = await workspacePath(workspaceManager, context, '.', { kind: 'directory' });
        let command = 'git --no-pager diff --no-color --';
        if (typeof input.path === 'string' && input.path) {
          const filePath = await workspacePath(workspaceManager, context, input.path, { mustExist: false });
          command += ` ${JSON.stringify(path.relative(cwd, filePath))}`;
        }
        const result = await runCommand(command, cwd, signal);
        return { content: result.output || '(aucune différence)', isError: result.exitCode !== 0, details: result };
      },
    });

    api.registerTool({
      name: 'bash',
      description: 'Exécuter une commande dans un workspace approuvé.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
      execute: async (raw, context, signal) => {
        requireTrust(context);
        const input = objectInput(raw);
        const command = requiredString(input, 'command');
        const cwd = await workspacePath(workspaceManager, context, '.', { kind: 'directory' });
        const result = await runCommand(command, cwd, signal);
        if (context.currentSessionId) {
          await context.sessionManager.addCommand(context.currentSessionId, {
            command,
            cwd,
            status: result.exitCode === 0 ? 'completed' : 'failed',
            output: result.output,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            truncated: result.truncated,
          });
        }
        return { content: result.output, isError: result.exitCode !== 0, details: result };
      },
    });

    if (process.platform === 'win32') api.registerTool({
      name: 'powershell',
      description: 'Execute an isolated PowerShell command in the trusted workspace.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
      execute: async (raw, context, signal) => {
        requireTrust(context);
        const input = objectInput(raw);
        const command = requiredString(input, 'command');
        const cwd = await workspacePath(workspaceManager, context, '.', { kind: 'directory' });
        const result = await runCommand(command, cwd, signal, 'powershell');
        if (context.currentSessionId) await context.sessionManager.addCommand(context.currentSessionId, {
          command,
          cwd,
          status: result.exitCode === 0 ? 'completed' : 'failed',
          output: result.output,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          truncated: result.truncated,
        });
        return { content: result.output, isError: result.exitCode !== 0, details: result };
      },
    });
  });
}
