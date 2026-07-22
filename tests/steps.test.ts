import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { record } from '../src/api.js';
import { loadSteps, runStep, StepError } from '../src/steps.js';
import { startDemoServer, type DemoServer } from './helpers/demo-server.js';

/**
 * Shared setup steps. The preamble to a bug is the same across most repros, and
 * the point of sharing it is that a break reports itself once, precisely.
 */

let server: DemoServer;
let root: string;
let stepsDir: string;

const step = (name: string, body: string) =>
  writeFile(path.join(stepsDir, `${name}.mjs`), body, 'utf8');

beforeAll(async () => {
  server = await startDemoServer(5441);
  root = await mkdtemp(path.join(tmpdir(), 'replay-steps-'));
  stepsDir = path.join(root, '.repros', 'steps');
  await mkdir(stepsDir, { recursive: true });

  await step(
    'sensors-loaded',
    `export default {
       name: 'sensors-loaded',
       description: 'On the sensors list with data present',
       ensures: '[data-testid="sensor-row-1"]',
       async run(page) { await page.waitForSelector('[data-testid="sensor-list"]'); },
     };`,
  );
  await step(
    'one-added',
    `export default {
       name: 'one-added',
       description: 'A sensor named Probe exists',
       requires: ['sensors-loaded'],
       ensures: '[data-testid="sensor-row-4"]',
       async run(page) {
         await page.fill('[data-testid="sensor-name-input"]', 'Probe');
         await page.click('[data-testid="add-sensor"]');
       },
     };`,
  );
  await step(
    'lies',
    `export default {
       name: 'lies',
       description: 'Claims to open a dialog it never opens',
       ensures: '[data-testid="never-appears"]',
       ensuresTimeoutMs: 1500,
       async run() {},
     };`,
  );
}, 60_000);

afterAll(async () => {
  await server?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('discovery', () => {
  it('lists what exists, so a fourth sign-in helper does not get written', async () => {
    const { steps, errors } = await loadSteps(stepsDir);
    expect(errors).toEqual([]);
    expect(Array.from(steps.keys()).sort()).toEqual(['lies', 'one-added', 'sensors-loaded']);
    expect(steps.get('one-added')?.description).toContain('Probe');
  });

  it('reports a broken file without hiding the rest', async () => {
    // One unloadable step must not make the others undiscoverable — that is
    // exactly when you need the list.
    await writeFile(path.join(stepsDir, 'broken.mjs'), 'export default { nope: true };', 'utf8');
    try {
      const { steps, errors } = await loadSteps(stepsDir);
      expect(steps.size).toBe(3);
      expect(errors[0]?.message).toContain('defineStep');
    } finally {
      await rm(path.join(stepsDir, 'broken.mjs'), { force: true });
    }
  });
});

describe('running', () => {
  it('runs dependencies first, and only once', async () => {
    const { repro } = await record({
      name: 'with-steps',
      baseUrl: server.baseUrl,
      root,
      headless: true,
      drive: async (page, { step: run, observe }) => {
        await run('one-added');
        // Requested again; the dependency must not re-run and add a second one.
        await run('sensors-loaded');
        await observe('[data-testid="sensor-row-4"]');
      },
    });
    expect(repro.assertion.finalState.domAppeared).toEqual(['[data-testid="sensor-row-4"]']);

    const sensors = (await (await fetch(`${server.baseUrl}/api/sensors`)).json()) as unknown[];
    expect(sensors, 'the dependency ran once, not twice').toHaveLength(4);
  });

  it('blames the step, not the repro, when a preamble stops working', async () => {
    // The whole reason to share a step: a break is diagnosed once and named,
    // instead of surfacing as several repros failing somewhere further along.
    const { steps } = await loadSteps(stepsDir);
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
      await expect(runStep('lies', page, steps)).rejects.toThrow(StepError);
      await expect(runStep('lies', page, steps)).rejects.toThrow(
        /did not reach the state it promises/,
      );
    } finally {
      await browser.close();
    }
  });

  it('names what is available when a step does not exist', async () => {
    const { steps } = await loadSteps(stepsDir);
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await expect(runStep('typo', page, steps)).rejects.toThrow(/Available: /);
    } finally {
      await browser.close();
    }
  });
});
