import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GoalNotReached, record, reproPaths, run } from '../src/api.js';
import { JevError, type ChoiceAnswer, type JevClient } from '../src/jev/client.js';
import { startDemoServer, type DemoServer } from './helpers/demo-server.js';

let server: DemoServer;
let root: string;

beforeAll(async () => {
  server = await startDemoServer(5448);
  root = await mkdtemp(path.join(tmpdir(), 'replay-jev-'));
}, 60_000);
afterAll(async () => {
  await server?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

/** Answers by matching option descriptions, so the test reads like the path it expects. */
function scriptedJev(picks: string[]): JevClient & { states: unknown[] } {
  const states: unknown[] = [];
  return {
    states,
    async choice(state, _instructions, criteria): Promise<ChoiceAnswer> {
      states.push(state);
      const want = picks.shift() ?? 'none';
      const key = want === 'none' ? 'none' : Object.keys(criteria).find((k) => criteria[k] === want);
      if (!key) throw new Error(`scripted pick not offered: ${want}\noffered: ${Object.values(criteria).join(' | ')}`);
      return { choice: key, confidence: 0.9, probabilities: { [key]: 0.9 } };
    },
  };
}

describe('goal-driven recording', () => {
  it('records the path Jev picks and replays it with no model', async () => {
    await fetch(`${server.baseUrl}/api/reset`, { method: 'POST' });
    const jev = scriptedJev(['type "Boiler inlet" in the "New sensor name" field', 'click button "Add sensor"']);
    const result = await record({
      name: 'jev-add',
      baseUrl: server.baseUrl,
      root,
      headless: true,
      goal: { goal: 'Add a sensor named Boiler inlet', until: 'text=Boiler inlet', inputs: { 'New sensor name': 'Boiler inlet' } },
      jev,
    });
    expect(result.goalPath).toEqual(['type "Boiler inlet" in the "New sensor name" field', 'click button "Add sensor"']);
    expect(result.repro.steps.length).toBeGreaterThanOrEqual(2);
    expect(await readFile(result.irPath, 'utf8')).not.toMatch(/data-jev/);

    await fetch(`${server.baseUrl}/api/reset`, { method: 'POST' });
    const replay = await run({ name: 'jev-add', root });
    expect(replay.failure?.kind).not.toBe('infrastructure');
  });

  it('waits for a request the last action started before checking --until', async () => {
    // Generating a report is deliberately slow (mock-api.ts's SLOW_REPORT_MS):
    // proves settle() waits for the POST the click starts rather than moving
    // on once the page's own load state goes idle.
    await fetch(`${server.baseUrl}/api/reset`, { method: 'POST' });
    const jev = scriptedJev([
      'click button "Reports" in navigation',
      'type "Weekly rollup" in the "Report title" field',
      'choose "Sensor 3" in the "Sensor" field',
      'click button "Generate report"',
    ]);
    const result = await record({
      name: 'jev-report',
      baseUrl: server.baseUrl,
      root,
      headless: true,
      goal: {
        goal: 'Generate a report titled Weekly rollup for Sensor 3',
        until: '[data-testid="report-result"]',
        inputs: { 'Report title': 'Weekly rollup', Sensor: 'Sensor 3' },
      },
      jev,
    });
    expect(result.goalPath).toEqual([
      'click button "Reports" in navigation',
      'type "Weekly rollup" in the "Report title" field',
      'choose "Sensor 3" in the "Sensor" field',
      'click button "Generate report"',
    ]);
  });

  it('saves nothing when Jev picks none', async () => {
    const jev = scriptedJev(['none']);
    const err = await record({
      name: 'jev-none',
      baseUrl: server.baseUrl,
      root,
      headless: true,
      goal: { goal: 'Change my password', until: 'text=Password changed' },
      jev,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(GoalNotReached);
    expect(err.reason).toBe('none');
    const paths = reproPaths('jev-none', root);
    expect(existsSync(paths.ir)).toBe(false);
    expect(existsSync(paths.storageState)).toBe(false);
  });

  it('names the input problem when the goal is not reached', async () => {
    const jev = scriptedJev(['none']);
    const err = await record({
      name: 'jev-badinput',
      baseUrl: server.baseUrl,
      root,
      headless: true,
      goal: { goal: 'Do something', until: 'text=Never there', inputs: { Nonexistent: 'x' } },
      jev,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(GoalNotReached);
    expect(err.reason).toBe('none');
    expect(err.message).toMatch(/--input labels not found on the last page: Nonexistent\. Fields there: /);
  });

  it('refuses a malformed answer instead of acting on it as if it were offered', async () => {
    // 'constructor' is inherited from Object.prototype, so a plain `in` check
    // used to treat it as an offered option and crash indexing candidates[NaN].
    const jev: JevClient = { async choice() { return { choice: 'constructor', confidence: 0.9, probabilities: {} }; } };
    const err = await record({
      name: 'jev-malformed',
      baseUrl: server.baseUrl,
      root,
      headless: true,
      goal: { goal: 'Wander', until: 'text=Never there' },
      jev,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(JevError);
    expect(err.message).toBe('Jev chose an option that was not offered.');
    expect(existsSync(reproPaths('jev-malformed', root).ir)).toBe(false);
  });

  it('refuses an out-of-range option instead of treating it as none', async () => {
    const jev: JevClient = { async choice() { return { choice: 'c999', confidence: 0.9, probabilities: {} }; } };
    const err = await record({
      name: 'jev-outofrange',
      baseUrl: server.baseUrl,
      root,
      headless: true,
      goal: { goal: 'Wander', until: 'text=Never there' },
      jev,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(JevError);
    expect(err.message).toBe('Jev chose an option that was not offered.');
  });

  it('saves nothing when the step limit is hit', async () => {
    const jev = scriptedJev(['click button "Reports" in navigation', 'click button "Sensors" in navigation']);
    const err = await record({
      name: 'jev-limit',
      baseUrl: server.baseUrl,
      root,
      headless: true,
      goal: { goal: 'Wander', until: 'text=Never there', maxSteps: 2 },
      jev,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(GoalNotReached);
    expect(err.reason).toBe('max-steps');
    expect(err.path).toEqual(['click button "Reports" in navigation', 'click button "Sensors" in navigation']);
    expect(existsSync(reproPaths('jev-limit', root).ir)).toBe(false);
  });

  it('saves nothing when the recording stops before the goal is reached for a reason other than the driver finishing', async () => {
    // The scripted answer closes the whole browser before responding, so the
    // context's own 'close' listener stops the session with 'browser-closed'
    // while the driver is still mid-choice, and driveError never gets set.
    const browser = await chromium.launch({ headless: true });
    const jev: JevClient = {
      async choice(_state, _instructions, criteria) {
        await browser.close();
        const key = Object.keys(criteria)[0]!;
        return { choice: key, confidence: 0.9, probabilities: { [key]: 0.9 } };
      },
    };
    try {
      const err = await record({
        name: 'jev-closed',
        baseUrl: server.baseUrl,
        root,
        headless: true,
        goal: { goal: 'Wander', until: 'text=Never there' },
        jev,
        browser,
      }).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/browser-closed/);
      const paths = reproPaths('jev-closed', root);
      expect(existsSync(paths.ir)).toBe(false);
      expect(existsSync(paths.storageState)).toBe(false);
    } finally {
      await browser.close().catch(() => {});
    }
  });

  it('asks nothing when until already holds', async () => {
    const jev = scriptedJev([]);
    const result = await record({
      name: 'jev-already',
      baseUrl: server.baseUrl,
      root,
      headless: true,
      goal: { goal: 'See sensors', until: 'text=Sensor 1' },
      jev,
    });
    expect(jev.states).toHaveLength(0);
    expect(result.goalPath).toEqual([]);
    expect(result.repro.steps.filter((s) => s.action !== 'goto')).toHaveLength(0);
  });

  it('refuses a goal without a key before opening a browser', async () => {
    const saved = { key: process.env.TYPESAFE_API_KEY, xdg: process.env.XDG_CONFIG_HOME };
    delete process.env.TYPESAFE_API_KEY;
    process.env.XDG_CONFIG_HOME = root;
    try {
      await expect(
        record({ name: 'jev-nokey', baseUrl: server.baseUrl, root, headless: true, goal: { goal: 'x', until: 'h1' } }),
      ).rejects.toThrow('--goal needs a TypeSafe key: set TYPESAFE_API_KEY or run repro jev login');
    } finally {
      if (saved.key !== undefined) process.env.TYPESAFE_API_KEY = saved.key;
      if (saved.xdg !== undefined) process.env.XDG_CONFIG_HOME = saved.xdg;
      else delete process.env.XDG_CONFIG_HOME;
    }
  });

  it('refuses goal and drive together', async () => {
    await expect(
      record({ name: 'jev-both', baseUrl: server.baseUrl, root, goal: { goal: 'x', until: 'h1' }, drive: async () => {}, jev: scriptedJev([]) }),
    ).rejects.toThrow(/goal.*drive/);
  });
});

describe('replay boundary', () => {
  it('never imports the Jev module', async () => {
    const dir = path.join(process.cwd(), 'src', 'replayer');
    for (const file of await readdir(dir)) {
      const text = await readFile(path.join(dir, file), 'utf8');
      expect(text, file).not.toMatch(/from ['"][^'"]*jev\//);
    }
  });
});
