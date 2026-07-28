import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyExtract, readRepro, record, replayFragment, run, suggestExtractions } from '../src/api.js';
import { applyExtraction, findCommonPrefixes, stepKey } from '../src/ir/extract.js';
import { renderStepModule } from '../src/extract.js';
import { parseRepro, StepSchema, type Repro, type Step } from '../src/ir/schema.js';
import { loadSteps, runStep, type LoadedStep } from '../src/steps.js';
import { startDemoServer, type DemoServer } from './helpers/demo-server.js';

/**
 * Extracting the preamble repros share. Detection is structural — masked step
 * keys group, raw equality gates a rewrite — and nothing is written without an
 * explicit apply carrying a caller-chosen name.
 */

const BASE = 'http://localhost:3000';

const mkRepro = (name: string, steps: unknown[], over: Record<string, unknown> = {}): Repro =>
  parseRepro(
    {
      version: 1,
      name,
      createdAt: new Date(0).toISOString(),
      baseUrl: BASE,
      startPath: '/',
      viewport: { width: 800, height: 600 },
      steps: steps.map((s, i) => ({ id: `s${i + 1}`, waitAfter: { timeoutMs: 1000 }, ...(s as object) })),
      assertion: { finalState: {}, invariants: {} },
      ...over,
    },
    `${name}.json`,
  );

const click = (selector: string, extra: Record<string, unknown> = {}): unknown => ({
  action: 'click',
  target: { candidates: [selector], semantic: `click ${selector}` },
  ...extra,
});
const fill = (selector: string, value: string): unknown => ({
  action: 'fill',
  value,
  target: { candidates: [selector], semantic: `fill ${selector}` },
});
const goto = (url: string): unknown => ({ action: 'goto', value: url });

describe('stepKey', () => {
  const key = (s: unknown, base = BASE) => stepKey(mkRepro('k', [s]).steps[0]!, base);

  it('masks volatile identifiers so the same flow on different rows matches', () => {
    expect(key(click('[data-testid="sensor-row-4"] > button'))).toBe(
      key(click('[data-testid="sensor-row-7"] > button')),
    );
    expect(key(fill('#user', 'user-1'))).toBe(key(fill('#user', 'user-2')));
    expect(key(click('[data-id="0b9e1c2d-1111-2222-3333-444455556666"]'))).toBe(
      key(click('[data-id="ffffffff-aaaa-bbbb-cccc-000011112222"]')),
    );
  });

  it('ignores prose but not what the step does', () => {
    const a = mkRepro('a', [click('#x')]).steps[0]!;
    const b = mkRepro('b', [click('#x')]).steps[0]!;
    b.target!.semantic = 'entirely different words';
    expect(stepKey(a, BASE)).toBe(stepKey(b, BASE));
    expect(key(click('#x'))).not.toBe(key(click('#y')));
    expect(key(click('#x'))).not.toBe(key({ ...(click('#x') as object), action: 'dblclick' }));
  });

  it('normalizes goto values so a different dev-server port still matches', () => {
    expect(key(goto('http://localhost:3000/login'))).toBe(
      key(goto('http://localhost:5000/login'), 'http://localhost:5000'),
    );
  });
});

describe('findCommonPrefixes', () => {
  const shared = [goto(`${BASE}/login`), fill('#user', 'seed'), click('#sign-in')];

  it('finds the maximal shared prefix and leaves the tails alone', () => {
    const candidates = findCommonPrefixes([
      { name: 'a', repro: mkRepro('a', [...shared, click('#tail-a')]) },
      { name: 'b', repro: mkRepro('b', [...shared, click('#tail-b'), click('#more')]) },
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.steps).toHaveLength(3);
    expect(candidates[0]!.repros).toEqual([
      { name: 'a', exact: true },
      { name: 'b', exact: true },
    ]);
    // Fragment ids are renumbered so the generated step reads from s1.
    expect(candidates[0]!.steps.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
  });

  it('respects the thresholds', () => {
    const one = [{ name: 'a', repro: mkRepro('a', [...shared, click('#t')]) }];
    expect(findCommonPrefixes(one)).toEqual([]);

    const short = [
      { name: 'a', repro: mkRepro('a', [click('#same'), click('#a2')]) },
      { name: 'b', repro: mkRepro('b', [click('#same'), click('#b2')]) },
    ];
    expect(findCommonPrefixes(short)).toEqual([]);
    expect(findCommonPrefixes(short, { minSteps: 1 })).toHaveLength(1);
  });

  it('reports both the wider-short and narrower-long prefix, nothing redundant', () => {
    const candidates = findCommonPrefixes([
      { name: 'a', repro: mkRepro('a', [...shared, click('#deep'), click('#a-tail')]) },
      { name: 'b', repro: mkRepro('b', [...shared, click('#deep'), click('#b-tail')]) },
      { name: 'c', repro: mkRepro('c', [...shared, click('#c-tail')]) },
    ]);
    expect(candidates).toHaveLength(2);
    // Widest first: three repros share 3 steps; two of them share a 4th.
    expect(candidates[0]!.repros.map((r) => r.name)).toEqual(['a', 'b', 'c']);
    expect(candidates[0]!.steps).toHaveLength(3);
    expect(candidates[1]!.repros.map((r) => r.name)).toEqual(['a', 'b']);
    expect(candidates[1]!.steps).toHaveLength(4);
  });

  it('never groups across a different startPath', () => {
    const candidates = findCommonPrefixes([
      { name: 'a', repro: mkRepro('a', [...shared, click('#t')]) },
      { name: 'b', repro: mkRepro('b', [...shared, click('#t')], { startPath: '/admin' }) },
    ]);
    expect(candidates).toEqual([]);
  });

  it('gives the fragment the slowest observed timeout per step', () => {
    const slow = mkRepro('slow', [...shared, click('#slow-tail')]);
    slow.steps[1]!.waitAfter.timeoutMs = 9000;
    const candidates = findCommonPrefixes([
      { name: 'fast', repro: mkRepro('fast', [...shared, click('#fast-tail')]) },
      { name: 'slow', repro: slow },
    ]);
    expect(candidates[0]!.steps.map((s) => s.waitAfter.timeoutMs)).toEqual([1000, 9000, 1000]);
  });

  it('flags a member that matches only after masking, instead of merging it', () => {
    const candidates = findCommonPrefixes([
      { name: 'a', repro: mkRepro('a', [fill('#user', 'user-1'), click('#go'), click('#ta')]) },
      { name: 'b', repro: mkRepro('b', [fill('#user', 'user-2'), click('#go'), click('#tb')]) },
    ]);
    expect(candidates).toHaveLength(1);
    // 'a' is the exemplar; 'b' differs in a raw value and must not be rewritten.
    expect(candidates[0]!.repros).toEqual([
      { name: 'a', exact: true },
      { name: 'b', exact: false },
    ]);
  });
});

describe('applyExtraction', () => {
  const shared = [goto(`${BASE}/login`), fill('#user', 'seed')];
  const fragmentOf = (): Step[] => mkRepro('f', shared).steps;

  it('moves the prefix into a setup reference and renumbers what remains', () => {
    const input = mkRepro('a', [...shared, click('#tail'), click('#end')]);
    const result = applyExtraction(input, fragmentOf(), 'signed-in');
    expect(result.applied).toBe(true);
    expect(result.repro.setup).toEqual([{ step: 'signed-in' }]);
    expect(result.repro.steps.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(result.repro.steps[0]!.target?.candidates[0]).toBe('#tail');
    expect(result.changes.join()).toContain('signed-in');
    // The input is untouched — the caller decides what to write.
    expect(input.steps).toHaveLength(4);
    expect(input.setup).toEqual([]);
  });

  it('appends after existing setup, preserving replay order', () => {
    const input = mkRepro('a', [...shared, click('#tail')], {
      setup: [{ step: 'workspace' }],
    });
    const result = applyExtraction(input, fragmentOf(), 'signed-in');
    expect(result.repro.setup).toEqual([{ step: 'workspace' }, { step: 'signed-in' }]);
  });

  it('refuses to reduce a repro to nothing but setup', () => {
    const input = mkRepro('a', shared);
    const result = applyExtraction(input, fragmentOf(), 'signed-in');
    expect(result.applied).toBe(false);
    expect(result.reason).toContain('whole repro');
  });

  it('refuses a masked-only match rather than rewriting the wrong values', () => {
    const input = mkRepro('a', [goto(`${BASE}/login`), fill('#user', 'user-2'), click('#t')]);
    const fragment = mkRepro('f', [goto(`${BASE}/login`), fill('#user', 'user-1')]).steps;
    const result = applyExtraction(input, fragment, 'signed-in');
    expect(result.applied).toBe(false);
    expect(result.reason).toContain('parameterize');
  });

  it('refuses when the repro drifted since the suggestion', () => {
    const input = mkRepro('a', [goto(`${BASE}/login`), click('#other'), click('#t')]);
    const result = applyExtraction(input, fragmentOf(), 'signed-in');
    expect(result.applied).toBe(false);
    expect(result.reason).toContain('no longer matches');
  });

  it('skips a repro that already references the step', () => {
    const input = mkRepro('a', [...shared, click('#t')], { setup: [{ step: 'signed-in' }] });
    const result = applyExtraction(input, fragmentOf(), 'signed-in');
    expect(result.applied).toBe(false);
    expect(result.reason).toContain('already references');
  });
});

describe('renderStepModule', () => {
  const fragment = mkRepro('f', [
    goto(`${BASE}/login`),
    { ...(click('#sign-in') as object), waitAfter: { timeoutMs: 2000, domAppeared: ['[data-testid="home"]'] } },
  ]).steps;

  it('emits a module whose fragment round-trips as valid IR', () => {
    const source = renderStepModule(
      {
        name: 'signed-in',
        description: 'Signed in as the seed user',
        ensures: '[data-testid="home"]',
        establishesSession: true,
        sourceRepros: ['a', 'b'],
      },
      fragment,
    );
    expect(source).toContain(`import { defineStep, replayFragment } from "fast-replay"`);
    expect(source).toContain('establishesSession: true');
    expect(source).toContain('fragment: steps');
    expect(source).toContain('common prefix of: a, b');

    const embedded = /const steps = (\[[\s\S]*?\]);\n\nexport default/.exec(source);
    expect(embedded, 'expected an embedded steps array').not.toBeNull();
    const parsed = z.array(StepSchema).parse(JSON.parse(embedded![1]!));
    expect(parsed).toHaveLength(2);
    expect(parsed[1]!.waitAfter.domAppeared).toEqual(['[data-testid="home"]']);
  });

  it('loads through loadSteps and replays through the fragment helper', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'replay-extract-mod-'));
    try {
      // The shim lives in a subdirectory so loadSteps does not try to load it
      // as a step; the generated module resolves it relatively.
      await mkdir(path.join(dir, 'lib'), { recursive: true });
      await writeFile(
        path.join(dir, 'lib', 'shim.mjs'),
        `export const defineStep = (d) => d;\n` +
          `export const replayFragment = async (page, steps) => {\n` +
          `  globalThis.__fragmentCalls = (globalThis.__fragmentCalls ?? 0) + 1;\n` +
          `  globalThis.__fragmentSteps = steps;\n` +
          `};\n`,
        'utf8',
      );
      await writeFile(
        path.join(dir, 'pre.mjs'),
        renderStepModule(
          { name: 'pre', description: 'test preamble', sourceRepros: ['a'], importFrom: './lib/shim.mjs' },
          fragment,
        ),
        'utf8',
      );

      const { steps, errors } = await loadSteps(dir);
      expect(errors).toEqual([]);
      const loaded = steps.get('pre');
      expect(loaded?.fragment).toHaveLength(2);

      (globalThis as Record<string, unknown>).__fragmentCalls = 0;
      await runStep('pre', {} as Page, steps);
      expect((globalThis as Record<string, unknown>).__fragmentCalls).toBe(1);
      expect((globalThis as Record<string, unknown>).__fragmentSteps).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('end to end against the demo app', () => {
  let server: DemoServer;
  let root: string;
  let fragment: Step[];

  beforeAll(async () => {
    server = await startDemoServer(5443);
    root = await mkdtemp(path.join(tmpdir(), 'replay-extract-'));
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  const preamble = async (page: Page): Promise<void> => {
    await page.waitForSelector('[data-testid="sensor-row-1"]');
    await page.fill('[data-testid="sensor-name-input"]', 'Probe');
    await page.click('[data-testid="add-sensor"]');
    await page.waitForSelector('[data-testid="sensor-row-4"]');
  };

  const stepsWith = (frag: Step[]): Map<string, LoadedStep> =>
    new Map([
      [
        'preamble',
        {
          name: 'preamble',
          description: 'A sensor named Probe exists',
          fragment: frag,
          file: 'programmatic',
          run: (page: Page) => replayFragment(page, frag),
        },
      ],
    ]);

  it('extracts the shared preamble and both repros still replay', async () => {
    await server.reset();
    await record({
      name: 'extract-a',
      baseUrl: server.baseUrl,
      root,
      headless: true,
      drive: async (page) => {
        await preamble(page);
        await page.click('button[aria-label="Delete Probe"]');
        await page.waitForSelector('[data-testid="confirm-toast"]');
      },
    });
    await server.reset();
    await record({
      name: 'extract-b',
      baseUrl: server.baseUrl,
      root,
      headless: true,
      drive: async (page) => {
        await preamble(page);
        await page.click('[data-testid="nav-reports"]');
        await page.waitForSelector('[data-testid="report-title-input"]');
      },
    });

    const { suggestions } = await suggestExtractions({ root });
    const found = suggestions[0];
    expect(found, 'expected a shared prefix candidate').toBeDefined();
    expect([...found!.repros].sort()).toEqual(['extract-a', 'extract-b']);
    expect(found!.inexactRepros).toEqual([]);
    expect(found!.stepCount).toBeGreaterThanOrEqual(2);
    fragment = found!.candidate.steps;

    const report = await applyExtract({ name: 'preamble', root });
    expect(report.stepFile).toContain(path.join('steps', 'preamble.mjs'));
    expect(existsSync(report.stepFile!)).toBe(true);
    expect([...report.perRepro.map((r) => r.name)].sort()).toEqual(['extract-a', 'extract-b']);
    expect(report.perRepro.every((r) => !r.skipped), JSON.stringify(report.perRepro)).toBe(true);

    const a = await readRepro('extract-a', root);
    expect(a.setup).toEqual([{ step: 'preamble' }]);
    expect(a.steps[0]!.id).toBe('s1');
    expect(a.steps.length).toBeLessThan(fragment.length + a.steps.length);

    // Replay through the real replayFragment. The steps map is programmatic so
    // the test does not depend on resolving the package name from a tmpdir.
    for (const name of ['extract-a', 'extract-b']) {
      await server.reset();
      const result = await run({ name, root, steps: stepsWith(fragment) });
      expect(result.passed, `${name}: ${JSON.stringify(result.failure)}`).toBe(true);
    }
  });

  it('re-running extract finds nothing new, and suggests converting a re-driven recording', async () => {
    // The two rewritten repros no longer share a recorded prefix…
    const { suggestions } = await suggestExtractions({ root });
    expect(suggestions).toEqual([]);

    // …but a fresh recording that re-drives the preamble by hand is recognized
    // against the generated step's fragment. (The generated module imports
    // 'fast-replay', which resolves via the package self-reference; skip the
    // assertion if the environment cannot load it.)
    await server.reset();
    await record({
      name: 'extract-c',
      baseUrl: server.baseUrl,
      root,
      headless: true,
      drive: async (page) => {
        await preamble(page);
        await page.click('[data-testid="nav-reports"]');
        await page.waitForSelector('[data-testid="report-title-input"]');
      },
    });
    const { steps: loadable } = await loadSteps(path.join(root, '.repros', 'steps'));
    if (loadable.has('preamble')) {
      const { existing } = await suggestExtractions({ root });
      expect(existing).toEqual([
        { step: 'preamble', repros: [{ name: 'extract-c', length: fragment.length }] },
      ]);
    }
  });

  it('a broken fragment reports COULD NOT VERIFY naming the step, not a bug verdict', async () => {
    const broken = JSON.parse(JSON.stringify(fragment)) as Step[];
    for (const step of broken) {
      if (step.target) step.target.candidates = ['[data-testid="does-not-exist"]'];
      step.waitAfter.timeoutMs = 1000;
    }
    await server.reset();
    const result = await run({ name: 'extract-a', root, steps: stepsWith(broken) });
    expect(result.passed).toBe(false);
    expect(result.failure?.kind).toBe('infrastructure');
    expect(result.failure?.semantic).toContain('preamble');
    expect(result.failure?.observed).toContain('fragment step');
  });
});
