import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { record, run } from '../src/api.js';
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
    'named',
    `export default {
       name: 'named',
       description: 'A sensor with the given name exists',
       ensures: '[data-testid="sensor-row-4"]',
       defaults: { name: 'Probe' },
       async run(page, { name }) {
         await page.waitForSelector('[data-testid="sensor-list"]');
         await page.fill('[data-testid="sensor-name-input"]', name);
         await page.click('[data-testid="add-sensor"]');
       },
     };`,
  );
  await step(
    'session',
    `export default {
       name: 'session',
       description: 'Establishes a session (counts its runs on globalThis)',
       establishesSession: true,
       ensures: '[data-testid="signed-in-badge"]',
       ensuresTimeoutMs: 3000,
       async run(page) {
         globalThis.__sessionRuns = (globalThis.__sessionRuns ?? 0) + 1;
         await page.evaluate(() => localStorage.setItem('replay-token', 'ok'));
         // A real sign-in lands on a fresh document; the badge reads the token at mount.
         await page.reload({ waitUntil: 'domcontentloaded' });
         await page.waitForSelector('[data-testid="signed-in-badge"]');
       },
     };`,
  );
  await step(
    'chatting',
    `export default {
       name: 'chatting',
       description: 'On the sensors list, signed in via the session dependency',
       requires: ['session'],
       ensures: '[data-testid="sensor-list"]',
       async run(page) { await page.waitForSelector('[data-testid="sensor-list"]'); },
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
    expect(Array.from(steps.keys()).sort()).toEqual([
      'chatting',
      'lies',
      'named',
      'one-added',
      'sensors-loaded',
      'session',
    ]);
    expect(steps.get('one-added')?.description).toContain('Probe');
  });

  it('reports a broken file without hiding the rest', async () => {
    // One unloadable step must not make the others undiscoverable — that is
    // exactly when you need the list.
    await writeFile(path.join(stepsDir, 'broken.mjs'), 'export default { nope: true };', 'utf8');
    try {
      const { steps, errors } = await loadSteps(stepsDir);
      expect(steps.size).toBe(6);
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

describe('a session step runs once, not per replay', () => {
  it('captures the session at record and skips the step on every replay', async () => {
    // The reported "multiple sessions": a sign-in setup step re-ran on every
    // verification and minted a fresh server session each time.
    (globalThis as unknown as { __sessionRuns: number }).__sessionRuns = 0;
    await server.reset();
    const { repro } = await record({
      name: 'sessioned',
      baseUrl: server.baseUrl,
      root,
      headless: true,
      drive: async (page, { step, observe }) => {
        await step('session');
        await observe('[data-testid="sensor-list"]');
      },
    });
    expect((globalThis as unknown as { __sessionRuns: number }).__sessionRuns).toBe(1);
    // The step reloaded the page. Setup is referenced, not recorded, so that
    // navigation must not surface as a goto step in the IR.
    expect(repro.steps.map((s) => s.action)).not.toContain('goto');

    (globalThis as unknown as { __sessionRuns: number }).__sessionRuns = 0;
    for (let i = 0; i < 3; i++) {
      await server.reset();
      const result = await run({ name: 'sessioned', root });
      expect(result.passed, `replay ${i + 1}`).toBe(true);
    }
    // Zero, because the captured session is restored instead of re-run.
    expect((globalThis as unknown as { __sessionRuns: number }).__sessionRuns).toBe(0);
  });

  it('skips a session step reached through requires, not just one invoked directly', async () => {
    // The dependency edge was the leak: `chatting` requires `session`, so the
    // sign-in never appears in setup[] under its own name — and replay re-ran
    // it on every verification.
    (globalThis as unknown as { __sessionRuns: number }).__sessionRuns = 0;
    await server.reset();
    const { repro } = await record({
      name: 'sessioned-via-requires',
      baseUrl: server.baseUrl,
      root,
      headless: true,
      drive: async (page, { step, observe }) => {
        await step('chatting');
        await observe('[data-testid="sensor-list"]');
      },
    });
    expect((globalThis as unknown as { __sessionRuns: number }).__sessionRuns).toBe(1);
    // The captured state must be the post-sign-in one, not the boot snapshot,
    // and it is the project's shared session rather than a per-repro copy.
    expect(repro.storageStatePath).toBe('.repros/sessions/session@localhost_5441.json');
    const state = await readFile(path.join(root, repro.storageStatePath!), 'utf8');
    expect(state).toContain('replay-token');

    (globalThis as unknown as { __sessionRuns: number }).__sessionRuns = 0;
    for (let i = 0; i < 3; i++) {
      await server.reset();
      const result = await run({ name: 'sessioned-via-requires', root });
      expect(result.passed, `replay ${i + 1}`).toBe(true);
    }
    expect((globalThis as unknown as { __sessionRuns: number }).__sessionRuns).toBe(0);
  });

  it('does not let an empty state file masquerade as a session', async () => {
    // A state file with nothing in it restores nothing. Skipping sign-in on
    // its existence alone replayed logged out.
    const statePath = path.join(root, '.repros/sessions/session@localhost_5441.json');
    const original = await readFile(statePath, 'utf8');
    await writeFile(statePath, JSON.stringify({ cookies: [], origins: [] }), 'utf8');
    try {
      (globalThis as unknown as { __sessionRuns: number }).__sessionRuns = 0;
      await server.reset();
      const result = await run({ name: 'sessioned', root });
      expect(result.passed, JSON.stringify(result.failure)).toBe(true);
      // The step must actually run this time — there is no session to restore.
      expect((globalThis as unknown as { __sessionRuns: number }).__sessionRuns).toBe(1);
    } finally {
      await writeFile(statePath, original, 'utf8');
    }
  });
});

describe('setup is referenced, not recorded', () => {
  it('keeps the preamble out of the IR', async () => {
    // Inlined, a preamble is copied into every repro that used it — so fixing
    // the shared function would fix none of them, which is the entire reason
    // to share it. The IR should hold the observation and nothing else.
    await server.reset();
    const { repro } = await record({
      name: 'referenced',
      baseUrl: server.baseUrl,
      root,
      headless: true,
      drive: async (page, { step, observe }) => {
        await step('one-added');
        await page.click('button[aria-label="Delete Probe"]');
        await page.waitForSelector('[data-testid="confirm-toast"]');
        await observe('[data-testid="confirm-toast"]');
      },
    });

    expect(repro.setup).toEqual([{ step: 'one-added' }]);
    expect(repro.steps).toHaveLength(1);
    expect(repro.steps[0]?.target?.semantic).toContain('Delete Probe');
  });

  it('runs the referenced setup at replay and passes', async () => {
    await server.reset();
    const result = await run({ name: 'referenced', root });
    expect(result.failure, JSON.stringify(result.failure)).toBeNull();
    expect(result.passed).toBe(true);
  });

  it('blames setup, not the bug, when a preamble stops working', async () => {
    await server.reset();
    const { readFile, writeFile } = await import('node:fs/promises');
    const irPath = path.join(root, '.repros/referenced.json');
    const original = await readFile(irPath, 'utf8');
    const broken = JSON.parse(original);
    broken.setup = [{ step: 'lies' }];
    await writeFile(irPath, JSON.stringify(broken, null, 2));

    try {
      const result = await run({ name: 'referenced', root });
      expect(result.passed).toBe(false);
      // Not a verdict on the bug: the flow never got to where the bug lives.
      expect(result.failure?.kind).toBe('infrastructure');
      expect(result.failure?.semantic).toContain('lies');
    } finally {
      await writeFile(irPath, original);
    }
  });

  it('names the file when a referenced step failed to load, not just "not defined"', async () => {
    // A broken .mjs used to reduce to a bare not-defined — and silently
    // disabled the session skip for whatever that file defined.
    await server.reset();
    await writeFile(path.join(stepsDir, 'from-broken.mjs'), 'export default {{{ nope', 'utf8');
    const irPath = path.join(root, '.repros/referenced.json');
    const original = await readFile(irPath, 'utf8');
    const broken = JSON.parse(original);
    broken.setup = [{ step: 'from-broken' }];
    await writeFile(irPath, JSON.stringify(broken, null, 2));

    try {
      const result = await run({ name: 'referenced', root });
      expect(result.passed).toBe(false);
      expect(result.failure?.kind).toBe('infrastructure');
      expect(result.failure?.observed).toContain('from-broken.mjs');
    } finally {
      await writeFile(irPath, original);
      await rm(path.join(stepsDir, 'from-broken.mjs'), { force: true });
    }
  });

  it('passes parameters through to the step and records them', async () => {
    await server.reset();
    const { repro } = await record({
      name: 'parameterised',
      baseUrl: server.baseUrl,
      root,
      headless: true,
      drive: async (page, { step, observe }) => {
        // The identical part is shared; only the unique value differs.
        await step('named', { name: 'Boiler' });
        await observe('[data-testid="sensor-row-4"]');
      },
    });
    expect(repro.setup).toEqual([{ step: 'named', params: { name: 'Boiler' } }]);

    const sensors = (await (await fetch(`${server.baseUrl}/api/sensors`)).json()) as {
      name: string;
    }[];
    expect(sensors.map((s) => s.name)).toContain('Boiler');
  });
});
