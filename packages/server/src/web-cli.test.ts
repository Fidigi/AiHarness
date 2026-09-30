import { describe, expect, it } from 'vitest';
import { parseWebCliArgs, webCliHelp } from './web-cli-options.js';

describe('ai-harness-web CLI', () => {
  it('uses secure local defaults', () => {
    expect(parseWebCliArgs([], {})).toEqual({
      port: 3080,
      hostname: '127.0.0.1',
      noOpen: false,
      help: false,
    });
  });

  it('reads environment variables', () => {
    expect(parseWebCliArgs([], {
      AI_HARNESS_WEB_PORT: '4100',
      AI_HARNESS_WEB_HOSTNAME: '0.0.0.0',
      AI_HARNESS_WEB_NO_OPEN: '1',
    })).toEqual({ port: 4100, hostname: '0.0.0.0', noOpen: true, help: false });
  });

  it('lets command-line options override the environment', () => {
    expect(parseWebCliArgs(
      ['-p', '8080', '-H', 'localhost', '--no-open'],
      { AI_HARNESS_WEB_PORT: '4100', AI_HARNESS_WEB_HOSTNAME: '0.0.0.0' },
    )).toEqual({ port: 8080, hostname: 'localhost', noOpen: true, help: false });
  });

  it('supports long options with equals syntax', () => {
    expect(parseWebCliArgs(['--port=8081', '--hostname=::1'], {})).toMatchObject({
      port: 8081,
      hostname: '::1',
    });
  });

  it('rejects invalid ports and unknown options', () => {
    expect(() => parseWebCliArgs(['--port', '0'], {})).toThrow(/Port invalide/);
    expect(() => parseWebCliArgs(['--unknown'], {})).toThrow(/Option inconnue/);
  });

  it('prints the command and available options in help', () => {
    expect(parseWebCliArgs(['--help'], {}).help).toBe(true);
    expect(webCliHelp()).toContain('ai-harness-web');
    expect(webCliHelp()).toContain('--hostname');
  });
});
