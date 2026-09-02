import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  hostSlug,
  parseSessionPath,
  persistSession,
  planSession,
  readMeta,
  readSessionState,
  sessionFiles,
  sessionKey,
} from '../src/sessions.js';
import type { LoadedStep } from '../src/steps.js';

/**
 * The pure half of project sessions: how a session is named on disk, and the
 * decision made before the browser opens. Nothing here touches Playwright.
 */

const step = (over: Partial<LoadedStep> & { name: string }): LoadedStep => ({
  description: '',
  file: `${over.name}.mjs`,
  async run() {},
  ...over,
});

const steps = new Map<string, LoadedStep>(
  [
    step({ name: 'signed-in', establishesSession: true, ensures: '[data-testid="avatar"]' }),
    step({ name: 'other-account', establishesSession: true, ensures: '[data-testid="avatar"]' }),
    step({ name: 'no-ensures', establishesSession: true }),
    step({ name: 'on-reports', requires: ['signed-in'], ensures: '[data-testid="reports"]' }),
    step({ name: 'plain', ensures: '[data-testid="list"]' }),
  ].map((s) => [s.name, s]),
);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'replay-sessions-plan-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const BASE = 'http://localhost:3000';
const withContent = JSON.stringify({
  cookies: [],
  origins: [{ origin: BASE, localStorage: [{ name: 'replay-token', value: 'ok' }] }],
});

describe('session naming', () => {
  it('keys by step, and by explicit params sorted', () => {
    expect(sessionKey('signed-in')).toBe('signed-in');
    expect(sessionKey('signed-in', {})).toBe('signed-in');
    expect(sessionKey('new-account', { plan: 'control', seed: '7' })).toBe(
      sessionKey('new-account', { seed: '7', plan: 'control' }),
    );
    expect(sessionKey('new-account', { plan: 'control' })).toMatch(/^new-account\.[0-9a-f]{6}$/);
    expect(sessionKey('new-account', { plan: 'control' })).not.toBe(sessionKey('new-account', { plan: 'pro' }));
  });

  it('writes the host with its port, colon as underscore, so the file name is legal everywhere', () => {
    expect(hostSlug('http://localhost:3000/some/path')).toBe('localhost_3000');
    expect(hostSlug('https://staging.example.com/')).toBe('staging.example.com');
  });

  it('round-trips a session path and rejects a per-repro state file', () => {
    const files = sessionFiles(root, 'signed-in', 'localhost_3000');
    expect(files.state).toBe(path.join(root, '.repros/sessions/signed-in@localhost_3000.json'));
    expect(files.meta).toBe(path.join(root, '.repros/sessions/signed-in@localhost_3000.meta.json'));
    expect(parseSessionPath(files.state)).toEqual({ key: 'signed-in', host: 'localhost_3000' });
    expect(parseSessionPath('.repros/sessions/new-account.a91f3c@staging.example.com.json')).toEqual({
      key: 'new-account.a91f3c',
      host: 'staging.example.com',
    });
    expect(parseSessionPath('.repros/checkout/state.json')).toBeNull();
    expect(parseSessionPath(files.meta!)).toBeNull();
  });

  it('treats an empty state file as no session', async () => {
    const files = sessionFiles(root, 'signed-in', 'localhost_3000');
    expect(readSessionState(files.state)).toBeNull();
    await mkdir(path.dirname(files.state), { recursive: true });
    await writeFile(files.state, JSON.stringify({ cookies: [], origins: [] }), 'utf8');
    expect(readSessionState(files.state)).toBeNull();
    await writeFile(files.state, withContent, 'utf8');
    expect(readSessionState(files.state)?.origins).toHaveLength(1);
  });

  it('accumulates proven paths and drops one that stopped proving', async () => {
    const files = sessionFiles(root, 'signed-in', 'localhost_3000');
    expect(readMeta(files.meta)).toEqual({ mintedAt: '', provenPaths: [] });
    await persistSession(files, withContent, { path: '/', proven: true });
    await persistSession(files, withContent, { path: '/reports', proven: true });
    expect(readMeta(files.meta).provenPaths).toEqual(['/', '/reports']);
    await persistSession(files, withContent, { path: '/', proven: false });
    const meta = readMeta(files.meta);
    expect(meta.provenPaths).toEqual(['/reports']);
    expect(Date.parse(meta.mintedAt)).toBeGreaterThan(0);
    expect(readMeta(null)).toEqual({ mintedAt: '', provenPaths: [] });
  });
});

describe('planSession', () => {
  const plan = (
    setup: { step: string; params?: Record<string, string> }[],
    over: Partial<Parameters<typeof planSession>[0]> = {},
  ) => planSession({ root, baseUrl: BASE, startPath: '/', setup, steps, explicitSeed: null, ...over });

  it('shares nothing when no session step is in the closure', () => {
    expect(plan([{ step: 'plain' }])).toEqual({ target: null, seedPath: null, probe: false, disabled: null });
    expect(plan([])).toEqual({ target: null, seedPath: null, probe: false, disabled: null });
  });

  it('finds the session step through requires and takes explicit params only from a direct entry', () => {
    const viaRequires = plan([{ step: 'on-reports' }]);
    expect(viaRequires.target?.step.name).toBe('signed-in');
    expect(viaRequires.target?.key).toBe('signed-in');
    const direct = plan([{ step: 'signed-in', params: { account: 'b' } }]);
    expect(direct.target?.key).toBe(sessionKey('signed-in', { account: 'b' }));
    expect(direct.target?.host).toBe('localhost_3000');
  });

  it('signs in for real when nothing is stored or the start path is unproven', async () => {
    expect(plan([{ step: 'signed-in' }])).toMatchObject({ seedPath: null, probe: false, disabled: null });
    const files = sessionFiles(root, 'signed-in', 'localhost_3000');
    await persistSession(files, withContent, { path: '/reports', proven: true });
    expect(plan([{ step: 'signed-in' }])).toMatchObject({ seedPath: null, probe: false });
  });

  it('seeds and probes only a stored session on a proven start path', async () => {
    const files = sessionFiles(root, 'signed-in', 'localhost_3000');
    await persistSession(files, withContent, { path: '/', proven: true });
    expect(plan([{ step: 'signed-in' }])).toMatchObject({ seedPath: files.state, probe: true, disabled: null });
    await writeFile(files.state, JSON.stringify({ cookies: [], origins: [] }), 'utf8');
    expect(plan([{ step: 'signed-in' }])).toMatchObject({ seedPath: null, probe: false });
  });

  it('disables sharing, and says why, for the cases a single seeded state cannot serve', () => {
    expect(plan([{ step: 'signed-in' }], { explicitSeed: 'storage-state' }).disabled).toMatch(/--storage-state/);
    expect(plan([{ step: 'signed-in' }], { explicitSeed: 'profile' }).disabled).toMatch(/--profile/);
    expect(plan([{ step: 'signed-in' }, { step: 'other-account' }]).disabled).toMatch(/single seeded state/);
    expect(plan([{ step: 'no-ensures' }]).disabled).toMatch(/no ensures/);
    for (const p of [
      plan([{ step: 'signed-in' }], { explicitSeed: 'profile' }),
      plan([{ step: 'no-ensures' }]),
    ]) {
      expect(p.target).toBeNull();
      expect(p.seedPath).toBeNull();
    }
  });
});
