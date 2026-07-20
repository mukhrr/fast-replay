import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureStorageState, openBrowser } from '../src/browser.js';
import { startDemoServer, type DemoServer } from './helpers/demo-server.js';

/**
 * Session seeding is the thing that decides whether this tool can be used on a
 * real app at all, because every worthwhile verification target sits behind a
 * login. These tests pin the two mechanisms against a real origin.
 *
 * The specific failure being guarded: `storageState()` omits IndexedDB by
 * default, which produces a state file that looks complete and restores nothing
 * for any app keeping its auth there — Onyx, Dexie, Firebase Auth. It fails
 * silently, as a login screen on the second run.
 */

const DB = 'replay-auth-probe';
const STORE = 'keyvaluepairs';

/** Mimics how an offline-first app stashes a session token. */
async function writeToken(page: import('playwright').Page, token: string): Promise<void> {
  await page.evaluate(
    ([db, store, value]) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(db as string, 1);
        open.onupgradeneeded = () => open.result.createObjectStore(store as string);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction(store as string, 'readwrite');
          tx.objectStore(store as string).put(value, 'session');
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      }),
    [DB, STORE, token] as const,
  );
}

async function readToken(page: import('playwright').Page): Promise<string | null> {
  return page.evaluate(
    ([db, store]) =>
      new Promise<string | null>((resolve) => {
        const open = indexedDB.open(db as string, 1);
        open.onupgradeneeded = () => open.result.createObjectStore(store as string);
        open.onerror = () => resolve(null);
        open.onsuccess = () => {
          const names = Array.from(open.result.objectStoreNames);
          if (!names.includes(store as string)) return resolve(null);
          const req = open.result.transaction(store as string, 'readonly')
            .objectStore(store as string)
            .get('session');
          req.onsuccess = () => resolve((req.result as string) ?? null);
          req.onerror = () => resolve(null);
        };
      }),
    [DB, STORE] as const,
  );
}

let server: DemoServer;
let workdir: string;
const viewport = { width: 1024, height: 768 };

beforeAll(async () => {
  server = await startDemoServer(5260);
  workdir = await mkdtemp(path.join(tmpdir(), 'replay-session-'));
}, 60_000);

afterAll(async () => {
  await server?.close();
  if (workdir) await rm(workdir, { recursive: true, force: true });
});

describe('session seeding', () => {
  it('carries an IndexedDB token across contexts via storageState', async () => {
    const first = await openBrowser({ headless: true, viewport });
    let state: string;
    try {
      await first.page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
      await writeToken(first.page, 'token-abc123');
      state = await captureStorageState(first.context);
    } finally {
      await first.close();
    }

    // Without `indexedDB: true` this file is written happily and contains
    // nothing of the session — the silent failure this test exists for.
    expect(state).toContain('token-abc123');

    const statePath = path.join(workdir, 'state.json');
    await writeFile(statePath, state);

    const second = await openBrowser({ headless: true, viewport, storageStatePath: statePath });
    try {
      await second.page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
      expect(await readToken(second.page)).toBe('token-abc123');
    } finally {
      await second.close();
    }
  });

  it('carries it across runs via a persistent profile', async () => {
    const profileDir = path.join(workdir, 'profile');

    const first = await openBrowser({ headless: true, viewport, profileDir });
    try {
      await first.page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
      await writeToken(first.page, 'token-profile-xyz');
    } finally {
      await first.close();
    }

    // A fresh launch against the same profile: nothing is seeded explicitly,
    // the data is simply still there. This is what makes a non-idempotent
    // signup survivable — you never sign up twice.
    const second = await openBrowser({ headless: true, viewport, profileDir });
    try {
      await second.page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
      expect(await readToken(second.page)).toBe('token-profile-xyz');
      expect(second.persistent).toBe(true);
    } finally {
      await second.close();
    }
  });

  it('starts clean when no session is seeded', async () => {
    const fresh = await openBrowser({ headless: true, viewport });
    try {
      await fresh.page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
      expect(await readToken(fresh.page)).toBeNull();
    } finally {
      await fresh.close();
    }
  });
});
