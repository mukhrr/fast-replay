import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { record, run, type Repro } from '../src/api.js';
import type { DriveApi } from '../src/recorder/launch.js';
import { startDemoServer, type DemoServer } from './helpers/demo-server.js';

/**
 * One sign-in per project. A session step declared in setup is seeded from the
 * project's stored session, probed on a proven start path, and re-established
 * only when it has died. Every sign-in is counted on globalThis so the tests
 * assert the number, not the feeling.
 */

let server: DemoServer;
let root: string;
let stepsDir: string;

const HOST = 'localhost_5445';
const g = globalThis as { __signIns?: number; __signInBroken?: boolean };
const signIns = (): number => g.__signIns ?? 0;
const resetSignIns = (): void => {
  g.__signIns = 0;
};

const step = (name: string, body: string): Promise<void> =>
  writeFile(path.join(stepsDir, `${name}.mjs`), body, 'utf8');

beforeAll(async () => {
  server = await startDemoServer(5445);
  root = await mkdtemp(path.join(tmpdir(), 'replay-sessions-'));
  stepsDir = path.join(root, '.repros', 'steps');
  await mkdir(stepsDir, { recursive: true });

  await step(
    'signed-in',
    `export default {
       name: 'signed-in',
       description: 'Signed in as the seed account',
       establishesSession: true,
       ensures: '[data-testid="signed-in-badge"]',
       // The badge renders with the page, so a probe that has not seen it in
       // three seconds is looking at a dead session, not a slow one.
       ensuresTimeoutMs: 3000,
       async run(page) {
         globalThis.__signIns = (globalThis.__signIns ?? 0) + 1;
         if (globalThis.__signInBroken) throw new Error('login form is gone');
         await page.evaluate(() => localStorage.setItem('replay-token', 'ok'));
         await page.reload({ waitUntil: 'domcontentloaded' });
         await page.waitForSelector('[data-testid="signed-in-badge"]');
       },
     };`,
  );
  await step(
    'signed-in-noisy',
    `export default {
       name: 'signed-in-noisy',
       description: 'Signed in, by a sign-in that fails a same-origin request on the way',
       establishesSession: true,
       ensures: '[data-testid="signed-in-badge"]',
       ensuresTimeoutMs: 3000,
       async run(page) {
         await page.evaluate(() => fetch('/api/does-not-exist').then(() => undefined));
         await page.evaluate(() => localStorage.setItem('replay-token', 'ok'));
         await page.reload({ waitUntil: 'domcontentloaded' });
         await page.waitForSelector('[data-testid="signed-in-badge"]');
       },
     };`,
  );
  await step(
    'on-reports',
    `export default {
       name: 'on-reports',
       description: 'On the reports page, signed in',
       requires: ['signed-in'],
       ensures: '[data-testid="report-title-input"]',
       async run(page) { await page.click('[data-testid="nav-reports"]'); },
     };`,
  );
  await step(
    'no-ensures',
    `export default {
       name: 'no-ensures',
       description: 'A session step that promises nothing',
       establishesSession: true,
       async run(page) {
         await page.evaluate(() => localStorage.setItem('replay-token', 'ok'));
         await page.reload({ waitUntil: 'domcontentloaded' });
       },
     };`,
  );
  await step(
    'other-account',
    `export default {
       name: 'other-account',
       description: 'A second account in the same browser',
       establishesSession: true,
       ensures: '[data-testid="signed-in-badge"]',
       async run(page) {
         await page.evaluate(() => localStorage.setItem('replay-token', 'ok'));
         await page.reload({ waitUntil: 'domcontentloaded' });
       },
     };`,
  );
  await step(
    'page-bound',
    `export default {
       name: 'page-bound',
       description: 'Signed in, verified by an element only the sensors page has',
       establishesSession: true,
       ensures: '[data-testid="sensor-list"]',
       ensuresTimeoutMs: 1500,
       async run(page) {
         await page.evaluate(() => localStorage.setItem('replay-token', 'ok'));
         await page.reload({ waitUntil: 'domcontentloaded' });
         await page.click('[data-testid="nav-sensors"]');
         await page.waitForSelector('[data-testid="sensor-list"]');
       },
     };`,
  );
}, 60_000);

afterAll(async () => {
  await server?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

/** From the sensors page: one recorded click, one piece of evidence. */
const driveFromSensors = async (page: Page, { observe }: DriveApi): Promise<void> => {
  await page.waitForSelector('[data-testid="sensor-row-1"]');
  await page.click('[data-testid="nav-reports"]');
  await page.waitForSelector('[data-testid="report-title-input"]');
  await observe('[data-testid="report-title-input"]');
};

/** From the reports page: the mirror image. */
const driveFromReports = async (page: Page, { observe }: DriveApi): Promise<void> => {
  await page.waitForSelector('[data-testid="report-title-input"]');
  await page.click('[data-testid="nav-sensors"]');
  await page.waitForSelector('[data-testid="sensor-list"]');
  await observe('[data-testid="sensor-list"]');
};

const rec = (
  name: string,
  setup: { step: string; params?: Record<string, string> }[],
  over: Partial<Parameters<typeof record>[0]> = {},
) =>
  record({
    name,
    baseUrl: server.baseUrl,
    root,
    headless: true,
    setup,
    drive: driveFromSensors,
    ...over,
  });

const sessionPath = (repro: Repro): string => path.join(root, repro.storageStatePath!);
const metaPath = (key: string, host = HOST): string =>
  path.join(root, '.repros', 'sessions', `${key}@${host}.meta.json`);
const readMetaFile = async (key: string, host = HOST): Promise<{ provenPaths: string[] }> =>
  JSON.parse(await readFile(metaPath(key, host), 'utf8')) as { provenPaths: string[] };

async function setToken(file: string, value: string): Promise<void> {
  const state = JSON.parse(await readFile(file, 'utf8')) as {
    origins?: { localStorage?: { name: string; value: string }[] }[];
  };
  for (const origin of state.origins ?? []) {
    for (const item of origin.localStorage ?? []) if (item.name === 'replay-token') item.value = value;
  }
  await writeFile(file, JSON.stringify(state), 'utf8');
}

describe('one sign-in per project, not per repro', () => {
  it('signs in once across two recordings that declare the same step', async () => {
    resetSignIns();
    await server.reset();
    const a = await rec('a', [{ step: 'signed-in' }]);
    await server.reset();
    const b = await rec('b', [{ step: 'signed-in' }]);

    expect(signIns()).toBe(1);
    expect(a.session?.status).toBe('established');
    expect(b.session?.status).toBe('reused');
    expect(a.repro.storageStatePath).toBe(`.repros/sessions/signed-in@${HOST}.json`);
    expect(b.repro.storageStatePath).toBe(a.repro.storageStatePath);
    expect(a.repro.sessionCheck).toEqual({ step: 'signed-in' });
    expect(b.repro.sessionCheck).toEqual({ step: 'signed-in' });
    expect(existsSync(path.join(root, '.repros/a/state.json'))).toBe(false);
    expect((await readMetaFile('signed-in')).provenPaths).toEqual(['/']);
    expect(a.repro.setup).toEqual([{ step: 'signed-in' }]);
    // The sign-in reloaded the page; setup is referenced, never recorded.
    expect(a.repro.steps.map((s) => s.action)).not.toContain('goto');
    expect(a.repro.steps.length).toBeGreaterThan(0);
    expect(a.warnings).toEqual([]);
  });

  it('reaches the session through requires and still runs the dependent step', async () => {
    resetSignIns();
    await server.reset();
    const c = await rec('c', [{ step: 'on-reports' }], { drive: driveFromReports });
    expect(signIns()).toBe(0);
    expect(c.session?.status).toBe('reused');
    expect(c.repro.setup).toEqual([{ step: 'on-reports' }]);
    expect(c.repro.sessionCheck).toEqual({ step: 'signed-in' });
  });

  it('signs in for real on a start path never proven, then proves it', async () => {
    resetSignIns();
    await server.reset();
    const d = await rec('d', [{ step: 'signed-in' }], { startPath: '/reports', drive: driveFromReports });
    expect(signIns()).toBe(1);
    expect(d.session?.status).toBe('established');
    expect(d.repro.sessionCheck).toEqual({ step: 'signed-in' });
    expect((await readMetaFile('signed-in')).provenPaths).toEqual(['/', '/reports']);

    await server.reset();
    const e = await rec('e', [{ step: 'signed-in' }], { startPath: '/reports', drive: driveFromReports });
    expect(signIns()).toBe(1);
    expect(e.session?.status).toBe('reused');
  });

  it('does not share a session step that promises nothing', async () => {
    await server.reset();
    const f = await rec('f', [{ step: 'no-ensures' }]);
    expect(f.session).toBeNull();
    expect(f.warnings.join('\n')).toMatch(/has no ensures/);
    expect(f.repro.storageStatePath).toBe('.repros/f/state.json');
    expect(f.repro.sessionCheck).toBeUndefined();
    expect(await readFile(path.join(root, '.repros/f/state.json'), 'utf8')).toContain('replay-token');
  });

  it('does not share when two session steps meet in one setup', async () => {
    await server.reset();
    const g2 = await rec('g', [{ step: 'signed-in' }, { step: 'other-account' }]);
    expect(g2.session).toBeNull();
    expect(g2.warnings.join('\n')).toMatch(/single seeded state/);
    expect(g2.repro.storageStatePath).toBe('.repros/g/state.json');
  });

  it('does not share when the caller seeds the context by hand', async () => {
    const seed = path.join(root, 'seed.json');
    await writeFile(seed, JSON.stringify({ cookies: [], origins: [] }), 'utf8');
    await server.reset();
    const h = await rec('h', [{ step: 'signed-in' }], { storageStatePath: seed });
    expect(h.session).toBeNull();
    expect(h.warnings.join('\n')).toMatch(/--storage-state/);
    expect(h.repro.storageStatePath).toBe('.repros/h/state.json');
  });

  it('marks nothing probeable when ensures is not visible on the start path', async () => {
    await server.reset();
    const i = await rec('i', [{ step: 'page-bound' }], { startPath: '/reports', drive: driveFromReports });
    expect(i.session?.status).toBe('established');
    expect(i.session?.proven).toBe(false);
    expect(i.warnings.join('\n')).toMatch(/not visible on \/reports/);
    expect(i.repro.sessionCheck).toBeUndefined();
    expect(i.repro.storageStatePath).toBe(`.repros/sessions/page-bound@${HOST}.json`);
    expect((await readMetaFile('page-bound')).provenPaths).toEqual([]);
  });

  it('leaves a shared session behind when a session step is invoked from drive()', async () => {
    resetSignIns();
    await server.reset();
    const j = await record({
      name: 'j',
      baseUrl: server.baseUrl,
      root,
      headless: true,
      drive: async (page, api) => {
        await api.step('signed-in');
        await driveFromSensors(page, api);
      },
    });
    expect(signIns()).toBe(1);
    expect(j.session?.status).toBe('established');
    expect(j.repro.storageStatePath).toBe(`.repros/sessions/signed-in@${HOST}.json`);
    expect(j.repro.setup).toEqual([{ step: 'signed-in' }]);
    expect(j.repro.sessionCheck).toEqual({ step: 'signed-in' });
    expect(j.repro.steps.map((s) => s.action)).not.toContain('goto');
  });

  it('does not retract proof when drive() signs in from a page other than the start path', async () => {
    const before = (await readMetaFile('signed-in')).provenPaths;
    expect(before).toContain('/');
    resetSignIns();
    await server.reset();
    const k = await record({
      name: 'k',
      baseUrl: server.baseUrl,
      root,
      headless: true,
      drive: async (page, api) => {
        await page.waitForSelector('[data-testid="sensor-row-1"]');
        await page.click('[data-testid="nav-reports"]');
        await page.waitForSelector('[data-testid="report-title-input"]');
        await api.step('signed-in');
        await api.observe('[data-testid="signed-in-badge"]');
      },
    });
    expect(signIns()).toBe(1);
    expect(k.session?.status).toBe('established');
    expect(k.session?.proven).toBe(false);
    expect(k.repro.sessionCheck).toBeUndefined();
    expect(k.repro.storageStatePath).toBe(`.repros/sessions/signed-in@${HOST}.json`);
    // Nothing was measured on the start path, so nothing was retracted.
    expect((await readMetaFile('signed-in')).provenPaths).toEqual(before);
  });
});

describe('replay trusts a proven session and heals it once when it dies', () => {
  const aIr = (): string => path.join(root, '.repros/a.json');
  const aState = (): string => path.join(root, '.repros', 'sessions', `signed-in@${HOST}.json`);

  it('replays with zero sign-ins while the session is alive', async () => {
    resetSignIns();
    for (let i = 0; i < 3; i++) {
      await server.reset();
      const result = await run({ name: 'a', root });
      expect(result.passed, JSON.stringify(result.failure)).toBe(true);
      expect(result.notes.join('\n')).not.toMatch(/re-established/);
    }
    expect(signIns()).toBe(0);
  });

  it('re-establishes an expired session once, says so, and stores the new one', async () => {
    await setToken(aState(), 'stale');
    resetSignIns();
    await server.reset();
    const healed = await run({ name: 'a', root });
    expect(healed.passed, JSON.stringify(healed.failure)).toBe(true);
    expect(healed.notes).toContain('session re-established via step "signed-in" (stored session had expired)');
    expect(signIns()).toBe(1);
    expect(await readFile(aState(), 'utf8')).toContain('"ok"');

    await server.reset();
    const next = await run({ name: 'a', root });
    expect(next.passed).toBe(true);
    expect(signIns()).toBe(1);
  });

  it('keeps a heal\'s own sign-in traffic out of the verdict', async () => {
    const state = path.join(root, '.repros', 'sessions', `signed-in-noisy@${HOST}.json`);
    await server.reset();
    const noisy = await rec('heal-noise', [{ step: 'signed-in-noisy' }]);
    // The sign-in's 404 is in the recorded signature because the recording
    // signed in too. A warm replay never signs in, so only a healed run can
    // fire it again, and it must not read as the bug coming back.
    expect(noisy.repro.assertion.observedAtRecord?.failedRequests.map((f) => f.urlPattern)).toContain(
      '/api/does-not-exist',
    );

    await setToken(state, 'stale');
    await server.reset();
    const healed = await run({ name: 'heal-noise', root, expectFixed: true });
    expect(healed.passed, JSON.stringify(healed.failure)).toBe(true);
    expect(healed.notes).toContain(
      'session re-established via step "signed-in-noisy" (stored session had expired)',
    );
  });

  it('reports COULD NOT VERIFY when the step cannot re-establish the session', async () => {
    await setToken(aState(), 'stale');
    g.__signInBroken = true;
    try {
      await server.reset();
      const result = await run({ name: 'a', root });
      expect(result.passed).toBe(false);
      expect(result.failure?.kind).toBe('infrastructure');
      expect(result.failure?.semantic).toContain('signed-in');
      expect(result.failure?.observed).toContain('login form is gone');
    } finally {
      g.__signInBroken = false;
      await setToken(aState(), 'ok');
    }
  });

  it('never probes a repro without sessionCheck, and probes once it is added by hand', async () => {
    const original = await readFile(aIr(), 'utf8');
    const ir = JSON.parse(original) as Record<string, unknown>;
    delete ir.sessionCheck;
    await writeFile(aIr(), JSON.stringify(ir, null, 2), 'utf8');
    await setToken(aState(), 'stale');
    try {
      resetSignIns();
      await server.reset();
      const blind = await run({ name: 'a', root });
      // The demo app gates nothing behind the badge, so a logged-out replay
      // still walks the flow. What matters is that nothing signed in.
      expect(blind.passed, JSON.stringify(blind.failure)).toBe(true);
      expect(signIns()).toBe(0);
      expect(blind.notes.join('\n')).not.toMatch(/re-established/);

      await writeFile(aIr(), original, 'utf8');
      await server.reset();
      const probed = await run({ name: 'a', root });
      expect(probed.passed).toBe(true);
      expect(signIns()).toBe(1);
      expect(probed.notes.join('\n')).toMatch(/re-established/);
    } finally {
      await writeFile(aIr(), original, 'utf8');
      await setToken(aState(), 'ok');
    }
  });

  it('keeps a repro from an earlier release, with its own state file, working unchanged', async () => {
    const original = await readFile(aIr(), 'utf8');
    const ir = JSON.parse(original) as Record<string, unknown>;
    delete ir.sessionCheck;
    ir.storageStatePath = '.repros/a/state.json';
    await mkdir(path.join(root, '.repros/a'), { recursive: true });
    await writeFile(path.join(root, '.repros/a/state.json'), await readFile(aState(), 'utf8'), 'utf8');
    await writeFile(aIr(), JSON.stringify(ir, null, 2), 'utf8');
    try {
      resetSignIns();
      await server.reset();
      const result = await run({ name: 'a', root });
      expect(result.passed, JSON.stringify(result.failure)).toBe(true);
      expect(signIns()).toBe(0);
    } finally {
      await writeFile(aIr(), original, 'utf8');
      await rm(path.join(root, '.repros/a/state.json'), { force: true });
    }
  });

  it('under --env, heals into the target host file and leaves the recorded one alone', async () => {
    const other = await startDemoServer(5446);
    const otherState = path.join(root, '.repros', 'sessions', 'signed-in@localhost_5446.json');
    try {
      await setToken(aState(), 'stale');
      resetSignIns();
      await other.reset();
      const healed = await run({ name: 'a', root, envUrl: other.baseUrl });
      expect(healed.passed, JSON.stringify(healed.failure)).toBe(true);
      expect(healed.notes.join('\n')).toMatch(/re-established/);
      expect(signIns()).toBe(1);
      expect(await readFile(otherState, 'utf8')).toContain('"ok"');
      expect(await readFile(aState(), 'utf8')).toContain('"stale"');

      await other.reset();
      const warm = await run({ name: 'a', root, envUrl: other.baseUrl });
      expect(warm.passed).toBe(true);
      expect(signIns()).toBe(1);
    } finally {
      await other.close();
      await setToken(aState(), 'ok');
    }
  });

  it('refuses by name when sessionCheck does not name a session step', async () => {
    const original = await readFile(aIr(), 'utf8');
    const ir = JSON.parse(original) as Record<string, unknown>;
    ir.sessionCheck = { step: 'on-reports' };
    await writeFile(aIr(), JSON.stringify(ir, null, 2), 'utf8');
    try {
      await server.reset();
      const result = await run({ name: 'a', root });
      expect(result.passed).toBe(false);
      expect(result.failure?.kind).toBe('infrastructure');
      expect(result.failure?.semantic).toBe('sessionCheck "on-reports"');
      expect(result.failure?.observed).toContain('on-reports');
      expect(result.failure?.observed).toContain('not a session step with ensures');
    } finally {
      await writeFile(aIr(), original, 'utf8');
    }
  });

  it('under --env, refuses to write a heal into a per-repro state file', async () => {
    const other = await startDemoServer(5446);
    const ownState = path.join(root, '.repros/a/state.json');
    const original = await readFile(aIr(), 'utf8');
    const ir = JSON.parse(original) as Record<string, unknown>;
    ir.storageStatePath = '.repros/a/state.json';
    await mkdir(path.join(root, '.repros/a'), { recursive: true });
    await writeFile(ownState, await readFile(aState(), 'utf8'), 'utf8');
    await setToken(ownState, 'stale');
    await writeFile(aIr(), JSON.stringify(ir, null, 2), 'utf8');
    const before = await readFile(ownState, 'utf8');
    try {
      resetSignIns();
      await other.reset();
      const healed = await run({ name: 'a', root, envUrl: other.baseUrl });
      expect(healed.passed, JSON.stringify(healed.failure)).toBe(true);
      expect(healed.notes.join('\n')).toMatch(/re-established/);
      expect(healed.notes.join('\n')).toMatch(/session not stored: --env/);
      expect(signIns()).toBe(1);
      // The file belongs to the recorded origin; the target host's cookies
      // must not land in it.
      expect(await readFile(ownState, 'utf8')).toBe(before);
    } finally {
      await other.close();
      await writeFile(aIr(), original, 'utf8');
      await rm(ownState, { force: true });
    }
  });

  it('under --url, reads back the session its own heal wrote', async () => {
    const other = await startDemoServer(5446);
    const otherState = path.join(root, '.repros', 'sessions', 'signed-in@localhost_5446.json');
    try {
      await rm(otherState, { force: true });
      await setToken(aState(), 'stale');
      resetSignIns();
      await other.reset();
      const cold = await run({ name: 'a', root, baseUrl: other.baseUrl });
      expect(cold.passed, JSON.stringify(cold.failure)).toBe(true);
      expect(signIns()).toBe(1);

      await other.reset();
      const warm = await run({ name: 'a', root, baseUrl: other.baseUrl });
      expect(warm.passed, JSON.stringify(warm.failure)).toBe(true);
      expect(warm.notes.join('\n')).not.toMatch(/re-established/);
      expect(signIns()).toBe(1);
    } finally {
      await other.close();
      await setToken(aState(), 'ok');
    }
  });

  it('under a persistent profile, heals but writes nothing to the sessions dir', async () => {
    const { readdir, stat } = await import('node:fs/promises');
    const profile = await mkdtemp(path.join(tmpdir(), 'replay-profile-'));
    const sessionsDir = path.join(root, '.repros', 'sessions');
    const before = (await readdir(sessionsDir)).sort();
    const mtime = (await stat(aState())).mtimeMs;
    try {
      resetSignIns();
      await server.reset();
      const result = await run({ name: 'a', root, profileDir: profile });
      expect(result.passed, JSON.stringify(result.failure)).toBe(true);
      // An empty profile has no session, so the probe fails and the step runs.
      expect(signIns()).toBe(1);
      expect(result.notes.join('\n')).toMatch(/re-established/);
      expect((await readdir(sessionsDir)).sort()).toEqual(before);
      expect((await stat(aState())).mtimeMs).toBe(mtime);
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  });
});
