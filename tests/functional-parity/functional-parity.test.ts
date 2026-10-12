import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertFixtureImportsAreAiHarnessOwned,
  assertProcessScenario,
  fixtureRoot,
  loadManifest,
  normalizeFixture,
  readExpected,
  runProcessScenario,
  runRuntimeProbe,
  runSessionScenario,
  runTypeProbe,
} from './harness.js';

const manifest = await loadManifest();
const targetCriteria = [
  ...Array.from({ length: 10 }, (_, index) => `CLI-RUN-${String(index + 1).padStart(2, '0')}`),
  'CLI-SES-03',
  'CLI-SES-04',
  'CLI-EXT-02',
  'CLI-MOD-09',
  'CLI-TOOL-06',
  ...Array.from({ length: 8 }, (_, index) => `CLI-AUT-${String(index + 1).padStart(2, '0')}`),
];

describe('functional parity harness contract', () => {
  it('maps every requested audit criterion to at least one executable scenario', () => {
    const scenarios = [
      ...manifest.processScenarios,
      ...manifest.sessionScenarios,
      ...manifest.sdkScenarios,
    ];
    const ids = scenarios.map(scenario => scenario.id);
    const covered = new Set(scenarios.flatMap(scenario => scenario.criteria));

    expect(manifest.version).toBe(1);
    expect(new Set(ids).size).toBe(ids.length);
    expect(targetCriteria.filter(criterion => !covered.has(criterion))).toEqual([]);
    expect([...covered].filter(criterion => !targetCriteria.includes(criterion))).toEqual([]);
  });

  it('keeps public probes independent from non-AiHarness package interfaces', async () => {
    await expect(assertFixtureImportsAreAiHarnessOwned()).resolves.toBeUndefined();
  });
});

describe.each(manifest.processScenarios)('$id', scenario => {
  it(scenario.description, async () => {
    const result = await runProcessScenario(scenario);
    try {
      const fixtures = await assertProcessScenario(scenario, result);
      expect(result.code, `${scenario.id}: stderr=${result.stderr.slice(-4_000)}`).toBe(scenario.expected.exitCode);
      expect(fixtures.actual).toEqual(fixtures.expected);
      if (scenario.expected.stdout.endsWith('.jsonl')) {
        expect(result.stdout.endsWith('\n')).toBe(result.stdout.length > 0);
        for (const line of result.stdout.trimEnd().split('\n').filter(Boolean)) {
          expect(() => JSON.parse(line)).not.toThrow();
        }
      }
    } finally {
      await result.cleanup();
    }
  }, 30_000);
});

describe.each(manifest.sessionScenarios)('$id', scenario => {
  it(scenario.description, async () => {
    const actual = `${JSON.stringify(await runSessionScenario(scenario), null, 2)}\n`;
    const expected = await readExpected(scenario.expected);
    expect(normalizeFixture(actual, scenario.expected)).toBe(normalizeFixture(expected, scenario.expected));
  });
});

describe.each(manifest.sdkScenarios)('$id', scenario => {
  it(scenario.description, async () => {
    const actual = scenario.kind === 'types'
      ? runTypeProbe(scenario.input)
      : await runRuntimeProbe(scenario.input);
    const expected = await readFile(path.join(fixtureRoot, scenario.expected), 'utf8');
    const encoded = `${JSON.stringify(actual, null, 2)}\n`;

    expect(normalizeFixture(encoded, scenario.expected)).toBe(normalizeFixture(expected, scenario.expected));
    if (scenario.expectSuccess !== undefined) {
      const success = scenario.kind === 'types'
        ? actual.success
        : actual.code === 0;
      expect(success).toBe(scenario.expectSuccess);
    }
  });
});
