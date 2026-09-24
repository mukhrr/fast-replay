import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GoalNotReached, record, reproPaths, run } from '../src/api.js';
import type { ChoiceAnswer, JevClient } from '../src/jev/client.js';
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

  it('saves nothing when the step limit is hit', async () => {
    const jev = scriptedJev(['click button "Reports"', 'click button "Sensors"']);
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
    expect(err.path).toEqual(['click button "Reports"', 'click button "Sensors"']);
    expect(existsSync(reproPaths('jev-limit', root).ir)).toBe(false);
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
