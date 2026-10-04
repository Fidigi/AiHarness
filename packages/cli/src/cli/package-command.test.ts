import { describe, expect, it } from 'vitest';
import {
  formatPackageCommandHelp,
  PackageCommandArgumentError,
  parsePackageCommandArguments,
} from './package-command.js';

describe('package command arguments', () => {
  it('parses aliases, scopes, trust, JSON output, and resource filters', () => {
    expect(parsePackageCommandArguments([
      'config', '@demo/plugin', '--project', '--approve', '--json',
      '--extensions=src/*.js,!src/legacy.js', '--skills=', '--prompts', '+prompts/review.md',
      '--themes', '-themes/legacy.json',
    ])).toEqual({
      action: 'configure',
      help: false,
      json: true,
      scope: 'project',
      selector: '@demo/plugin',
      projectTrust: true,
      resetFilters: false,
      filters: {
        extensions: ['src/*.js', '!src/legacy.js'],
        skills: [],
        prompts: ['+prompts/review.md'],
        themes: ['-themes/legacy.json'],
      },
    });
    expect(parsePackageCommandArguments(['uninstall', 'npm:@demo/plugin'])).toMatchObject({ action: 'remove' });
  });

  it('rejects unknown actions, conflicts, missing selectors, and misplaced filters', () => {
    expect(() => parsePackageCommandArguments(['unknown'])).toThrow(PackageCommandArgumentError);
    expect(() => parsePackageCommandArguments(['install'])).toThrow(/requires a source/i);
    expect(() => parsePackageCommandArguments(['remove'])).toThrow(/requires a package selector/i);
    expect(() => parsePackageCommandArguments(['list', '--global', '--project'])).toThrow(/conflict/i);
    expect(() => parsePackageCommandArguments(['list', '--skills', 'skills'])).toThrow(/only to package configure/i);
    expect(() => parsePackageCommandArguments(['configure', 'one'])).toThrow(/filter or --reset/i);
    expect(() => parsePackageCommandArguments(['configure', 'one', '--reset', '--themes=night.json']))
      .toThrow(/cannot be combined/i);
    expect(() => parsePackageCommandArguments(['list', 'unexpected'])).toThrow(/does not accept/i);
  });

  it('provides command-specific help', () => {
    expect(formatPackageCommandHelp()).toContain('package install');
    expect(formatPackageCommandHelp()).toContain('--extensions');
    expect(formatPackageCommandHelp()).toContain('never contact npm/Git');
  });
});
