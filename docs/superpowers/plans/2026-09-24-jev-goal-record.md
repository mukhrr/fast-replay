# Jev Goal-Driven Recording Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optional Jev support: `repro record --goal ... --until ...` lets TypeSafe's Jev pick each next action while recording; without a key fast-replay behaves exactly as 0.13.0. Ship as 1.0.0.

**Architecture:** A new `src/jev/` module (key store, HTTP client, page primitives, goal loop) produces an ordinary `drive(page, api)` function that plugs into the existing `record()` drive seam, so capture, compile, IR and replay are untouched. The CLI, MCP server and first-run notice are thin additions on top. Replay never imports `src/jev/`.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node 20+ global `fetch`, Playwright 1.61, commander 14, zod 4, vitest.

**Spec:** `docs/superpowers/specs/2026-09-24-jev-goal-record-design.md`

## Global Constraints

- No new runtime dependency. Jev is called with global `fetch` at `POST https://api.typesafe.ai/v1/systemone`, header `Authorization: Bearer <key>`, body `{ model: "jev-latest", state, questions: { next: { type: "choice", instructions, criteria } } }`.
- No model calls at replay: nothing under `src/replayer/` imports anything under `src/jev/`.
- Without a key: no network call, no behaviour change. `--goal` without a key refuses with exactly: `--goal needs a TypeSafe key: set TYPESAFE_API_KEY or run repro jev login`.
- Key resolution: `TYPESAFE_API_KEY` (trimmed, non-empty), then `<XDG_CONFIG_HOME or ~/.config>/fast-replay/credentials.json`, written with mode `0o600`. Never in the project directory.
- A goal recording that did not reach `--until` writes nothing to `.repros/`.
- The driver never writes to the page DOM (no marker attributes).
- Retries: 429 and 529 only, after 500, 1000, 2000 ms; 30 s timeout per request.
- Max candidates per step 200; default `--max-steps` 12.
- Comments state design rationale only, one or two sentences, no em dashes (see CLAUDE.md).
- Tests run with `npx vitest run <file>`; integration tests boot the demo app with `startDemoServer(port)` from `tests/helpers/demo-server.ts`. Port 5448 is free; the new Jev test files use it (tests run one file at a time, so they do not collide).

## Review Focus

1. A goal that is not reached leaves no IR and no `state.json` under `.repros/` (the existing `record()` writes before throwing for drive files). Pinned in Task 4.
2. `--input "Note=a=b"`: the value contains `=`; split on the first `=` only. Pinned in Task 5.
3. A credentials file with invalid JSON must fail naming the file, not silently act as "no key". Pinned in Task 1.
4. A key pasted with a trailing newline (common with `pbpaste | repro jev login`) must be trimmed before use and save. Pinned in Task 1 and Task 5.
5. `--until` already true before the first step: zero actions, and the CLI's existing "No actions captured" path runs rather than a crash. Pinned in Task 4.

---

### Task 1: Key store

**Files:**
- Create: `src/jev/key.ts`
- Test: `tests/jev-key.test.ts`

**Interfaces:**
- Produces:
  - `configDir(env?: NodeJS.ProcessEnv): string`
  - `credentialsPath(env?: NodeJS.ProcessEnv): string`
  - `resolveKey(env?: NodeJS.ProcessEnv): { key: string; source: 'env' | 'file' } | null`
  - `saveKey(key: string, env?: NodeJS.ProcessEnv): string` (returns the file path)
  - `deleteKey(env?: NodeJS.ProcessEnv): boolean`
  - `NO_KEY_MESSAGE: string`

- [ ] **Step 1: Write the failing test**

```ts
// tests/jev-key.test.ts
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { credentialsPath, deleteKey, resolveKey, saveKey } from '../src/jev/key.js';

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'jev-key-'));
  env = { XDG_CONFIG_HOME: dir };
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

describe('jev key', () => {
  it('resolves to null when nothing is set', () => {
    expect(resolveKey(env)).toBeNull();
  });

  it('writes the file under XDG_CONFIG_HOME with mode 0600', async () => {
    const file = saveKey('apikey_abc', env);
    expect(file).toBe(path.join(dir, 'fast-replay', 'credentials.json'));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(resolveKey(env)).toEqual({ key: 'apikey_abc', source: 'file' });
  });

  it('trims a pasted newline before saving', () => {
    saveKey('apikey_abc\n', env);
    expect(resolveKey(env)?.key).toBe('apikey_abc');
  });

  it('prefers the env var over the file, trimmed', () => {
    saveKey('apikey_file', env);
    expect(resolveKey({ ...env, TYPESAFE_API_KEY: ' apikey_env\n' })).toEqual({ key: 'apikey_env', source: 'env' });
  });

  it('ignores an empty env var', () => {
    expect(resolveKey({ ...env, TYPESAFE_API_KEY: '  ' })).toBeNull();
  });

  it('fails naming the file when it is not valid JSON', async () => {
    await mkdir(path.dirname(credentialsPath(env)), { recursive: true });
    await writeFile(credentialsPath(env), '{nope', 'utf8');
    expect(() => resolveKey(env)).toThrow(/credentials\.json/);
  });

  it('deletes the file and reports whether there was one', async () => {
    saveKey('apikey_abc', env);
    expect(deleteKey(env)).toBe(true);
    expect(deleteKey(env)).toBe(false);
    await expect(readFile(credentialsPath(env))).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/jev-key.test.ts`
Expected: FAIL, cannot resolve `../src/jev/key.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/jev/key.ts
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const NO_KEY_MESSAGE = '--goal needs a TypeSafe key: set TYPESAFE_API_KEY or run repro jev login';

// Outside the project on purpose: `repro init` commits .repros/config.json.
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'fast-replay');
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(configDir(env), 'credentials.json');
}

export function resolveKey(env: NodeJS.ProcessEnv = process.env): { key: string; source: 'env' | 'file' } | null {
  const fromEnv = env.TYPESAFE_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: 'env' };
  const file = credentialsPath(env);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let parsed: { typesafeApiKey?: unknown };
  try {
    parsed = JSON.parse(raw) as { typesafeApiKey?: unknown };
  } catch (err) {
    throw new Error(`${file}: not valid JSON (${(err as Error).message}). Run repro jev logout, then repro jev login.`);
  }
  const key = typeof parsed.typesafeApiKey === 'string' ? parsed.typesafeApiKey.trim() : '';
  return key ? { key, source: 'file' } : null;
}

export function saveKey(key: string, env: NodeJS.ProcessEnv = process.env): string {
  const file = credentialsPath(env);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ typesafeApiKey: key.trim() }, null, 2) + '\n', { mode: 0o600 });
  // writeFileSync's mode only applies when it creates the file.
  chmodSync(file, 0o600);
  return file;
}

export function deleteKey(env: NodeJS.ProcessEnv = process.env): boolean {
  const file = credentialsPath(env);
  try {
    readFileSync(file);
  } catch {
    return false;
  }
  rmSync(file);
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/jev-key.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/jev/key.ts tests/jev-key.test.ts
git commit -m "Store the Jev key outside the project"
```

---

### Task 2: Jev HTTP client

**Files:**
- Create: `src/jev/client.ts`
- Test: `tests/jev-client.test.ts`

**Interfaces:**
- Produces:
  - `interface ChoiceAnswer { choice: string; confidence: number; probabilities: Record<string, number> }`
  - `interface JevClient { choice(state: unknown, instructions: string, criteria: Record<string, string>): Promise<ChoiceAnswer> }`
  - `class JevError extends Error { readonly kind: 'auth' | 'invalid' | 'overloaded' | 'network' }`
  - `createJevClient(key: string, options?: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; timeoutMs?: number }): JevClient`
  - `JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'`

- [ ] **Step 1: Write the failing test**

```ts
// tests/jev-client.test.ts
import { describe, expect, it } from 'vitest';
import { createJevClient, JevError, JEV_ENDPOINT } from '../src/jev/client.js';

const ok = (choice = 'c0') =>
  new Response(JSON.stringify({ model: 'jev-1', answers: { next: { type: 'choice', choice, confidence: 0.9, probabilities: { [choice]: 0.95, none: 0.05 } } } }), { status: 200 });

function fakeFetch(responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift()!;
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const noSleep = async () => {};

describe('jev client', () => {
  it('sends one choice question with the bearer key', async () => {
    const f = fakeFetch([ok('c1')]);
    const client = createJevClient('apikey_x', { fetch: f.fn, sleep: noSleep });
    const answer = await client.choice({ goal: 'g' }, 'Which?', { c0: 'a', c1: 'b', none: 'none' });
    expect(answer.choice).toBe('c1');
    expect(f.calls[0].url).toBe(JEV_ENDPOINT);
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer apikey_x');
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({
      model: 'jev-latest',
      state: { goal: 'g' },
      questions: { next: { type: 'choice', instructions: 'Which?', criteria: { c0: 'a', c1: 'b', none: 'none' } } },
    });
  });

  it('does not retry a 401 and names repro jev login', async () => {
    const f = fakeFetch([new Response('{}', { status: 401 })]);
    const err = await createJevClient('k', { fetch: f.fn, sleep: noSleep }).choice({}, 'q', { a: 'a' }).catch((e) => e);
    expect(err).toBeInstanceOf(JevError);
    expect(err.kind).toBe('auth');
    expect(err.message).toMatch(/repro jev login/);
    expect(f.calls).toHaveLength(1);
  });

  it('retries 529 three times, then refuses as overloaded', async () => {
    const f = fakeFetch([529, 529, 529, 529].map((s) => new Response('{}', { status: s })));
    const err = await createJevClient('k', { fetch: f.fn, sleep: noSleep }).choice({}, 'q', { a: 'a' }).catch((e) => e);
    expect(err.kind).toBe('overloaded');
    expect(f.calls).toHaveLength(4);
  });

  it('recovers when a retry succeeds', async () => {
    const f = fakeFetch([new Response('{}', { status: 429 }), ok()]);
    const answer = await createJevClient('k', { fetch: f.fn, sleep: noSleep }).choice({}, 'q', { c0: 'a' });
    expect(answer.choice).toBe('c0');
  });

  it('passes the API message through on 422', async () => {
    const f = fakeFetch([new Response(JSON.stringify({ detail: 'criteria must not be empty' }), { status: 422 })]);
    const err = await createJevClient('k', { fetch: f.fn, sleep: noSleep }).choice({}, 'q', {}).catch((e) => e);
    expect(err.kind).toBe('invalid');
    expect(err.message).toMatch(/criteria must not be empty/);
  });

  it('reports a network failure by name', async () => {
    const f = fakeFetch([new TypeError('fetch failed')]);
    const err = await createJevClient('k', { fetch: f.fn, sleep: noSleep }).choice({}, 'q', { a: 'a' }).catch((e) => e);
    expect(err.kind).toBe('network');
    expect(err.message).toMatch(/fetch failed/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/jev-client.test.ts`
Expected: FAIL, cannot resolve `../src/jev/client.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/jev/client.ts
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const RETRY_DELAYS_MS = [500, 1000, 2000];

export interface ChoiceAnswer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface JevClient {
  choice(state: unknown, instructions: string, criteria: Record<string, string>): Promise<ChoiceAnswer>;
}

export class JevError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'invalid' | 'overloaded' | 'network',
  ) {
    super(message);
    this.name = 'JevError';
  }
}

export function createJevClient(
  key: string,
  options: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; timeoutMs?: number } = {},
): JevClient {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = options.timeoutMs ?? 30_000;

  return {
    async choice(state, instructions, criteria) {
      const body = JSON.stringify({
        model: 'jev-latest',
        state,
        questions: { next: { type: 'choice', instructions, criteria } },
      });
      for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
          res = await doFetch(JEV_ENDPOINT, {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body,
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (err) {
          throw new JevError(`Jev request failed: ${(err as Error).message}`, 'network');
        }
        if (res.ok) {
          const json = (await res.json()) as { answers: { next: ChoiceAnswer } };
          return json.answers.next;
        }
        if (res.status === 401 || res.status === 403) {
          throw new JevError('Jev rejected the API key. Run repro jev login with a valid key.', 'auth');
        }
        if (res.status === 422 || res.status === 400) {
          throw new JevError(`Jev refused the request: ${await res.text()}`, 'invalid');
        }
        if ((res.status === 429 || res.status === 529) && attempt < RETRY_DELAYS_MS.length) {
          await sleep(RETRY_DELAYS_MS[attempt]!);
          continue;
        }
        throw new JevError(`Jev is unavailable (HTTP ${res.status}) after ${attempt + 1} attempts.`, 'overloaded');
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/jev-client.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/jev/client.ts tests/jev-client.test.ts
git commit -m "Call Jev over fetch with retries on 429 and 529 only"
```

---

### Task 3: Page primitives (until, candidates, state)

**Files:**
- Create: `src/jev/page.ts`
- Test: `tests/jev-page.test.ts`

**Interfaces:**
- Produces:
  - `type UntilCheck = { kind: 'selector' | 'text' | 'url'; value: string }`
  - `parseUntil(until: string): UntilCheck`
  - `untilHolds(page: Page, check: UntilCheck): Promise<boolean>`
  - `interface Candidate { kind: 'click' | 'fill' | 'select'; desc: string; value?: string }`
  - `collectCandidates(page: Page, inputs: Record<string, string>): Promise<{ candidates: Candidate[]; element(i: number): Promise<ElementHandle<Element>>; dispose(): Promise<void> }>`
  - `readPageState(page: Page): Promise<{ current_path: string; headings: string[]; fields: Record<string, string>; messages: string[] }>`
  - `MAX_CANDIDATES = 200`

- [ ] **Step 1: Write the failing test**

```ts
// tests/jev-page.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { collectCandidates, parseUntil, readPageState, untilHolds } from '../src/jev/page.js';

let browser: Browser;
let page: Page;

const HTML = `
<h1>Account</h1><h2>Security</h2>
<nav><a href="/home">Home</a><button>Save</button><button disabled>Locked</button><button style="display:none">Hidden</button></nav>
<label for="t">Title</label><input id="t" value="draft">
<label for="p">Password</label><input id="p" type="password" value="hunter2">
<label for="s">Sensor</label><select id="s"><option>Sensor 1</option><option>Sensor 3</option></select>
<input aria-label="Search">
<div role="status">Saved</div>`;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});
afterAll(async () => browser?.close());

describe('parseUntil', () => {
  it('reads selector, text= and url= forms', () => {
    expect(parseUntil('[data-testid="x"]')).toEqual({ kind: 'selector', value: '[data-testid="x"]' });
    expect(parseUntil('text=Report ready')).toEqual({ kind: 'text', value: 'Report ready' });
    expect(parseUntil('url=/reports')).toEqual({ kind: 'url', value: '/reports' });
  });
  it('refuses an empty check', () => {
    expect(() => parseUntil('  ')).toThrow(/--until/);
  });
});

describe('page primitives', () => {
  it('checks until against the live page', async () => {
    await page.setContent(HTML);
    expect(await untilHolds(page, parseUntil('text=Saved'))).toBe(true);
    expect(await untilHolds(page, parseUntil('text=Nope'))).toBe(false);
    expect(await untilHolds(page, parseUntil('h2'))).toBe(true);
    expect(await untilHolds(page, parseUntil('url=about:blank'))).toBe(true);
  });

  it('offers visible enabled controls and only fields named in inputs', async () => {
    await page.setContent(HTML);
    const found = await collectCandidates(page, { Title: 'Weekly', Sensor: 'Sensor 3', Search: 'x' });
    expect(found.candidates.map((c) => c.desc)).toEqual([
      'click link "Home"',
      'click button "Save"',
      'type "Weekly" in the "Title" field',
      'choose "Sensor 3" in the "Sensor" field',
      'type "x" in the "Search" field',
    ]);
    await found.dispose();
  });

  it('skips a field that already holds its value', async () => {
    await page.setContent(HTML);
    const found = await collectCandidates(page, { Title: 'draft' });
    expect(found.candidates.some((c) => c.desc.includes('Title'))).toBe(false);
    await found.dispose();
  });

  it('acts on the element it offered without writing to the DOM', async () => {
    await page.setContent(HTML);
    const before = await page.content();
    const found = await collectCandidates(page, { Title: 'Weekly' });
    const idx = found.candidates.findIndex((c) => c.kind === 'fill');
    await (await found.element(idx)).fill('Weekly');
    await found.dispose();
    expect(await page.inputValue('#t')).toBe('Weekly');
    expect(before).not.toMatch(/data-jev/);
    expect(await page.content()).not.toMatch(/data-jev/);
  });

  it('masks password values in the state sent to Jev', async () => {
    await page.setContent(HTML);
    const state = await readPageState(page);
    expect(state.headings).toEqual(['Account', 'Security']);
    expect(state.fields).toEqual({ Title: 'draft', Password: '********', Sensor: 'Sensor 1', Search: '' });
    expect(state.messages).toEqual(['Saved']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/jev-page.test.ts`
Expected: FAIL, cannot resolve `../src/jev/page.js`.

- [ ] **Step 3: Write the implementation**

Keep the in-page functions free of nested named function declarations: Playwright serializes them into page scope, where bundler helpers do not exist (the same reason `keepNames` is off for the agent bundle).

```ts
// src/jev/page.ts
import type { ElementHandle, JSHandle, Page } from 'playwright';

export const MAX_CANDIDATES = 200;

export type UntilCheck = { kind: 'selector' | 'text' | 'url'; value: string };

export interface Candidate {
  kind: 'click' | 'fill' | 'select';
  desc: string;
  value?: string;
}

export function parseUntil(until: string): UntilCheck {
  const trimmed = until.trim();
  if (!trimmed) throw new Error('--until needs a selector, text=<visible text> or url=<part of the URL>');
  if (trimmed.startsWith('text=')) return { kind: 'text', value: trimmed.slice(5) };
  if (trimmed.startsWith('url=')) return { kind: 'url', value: trimmed.slice(4) };
  return { kind: 'selector', value: trimmed };
}

export async function untilHolds(page: Page, check: UntilCheck): Promise<boolean> {
  if (check.kind === 'url') return page.url().includes(check.value);
  const locator = check.kind === 'text' ? page.getByText(check.value, { exact: true }) : page.locator(check.value);
  return (await locator.count()) > 0 && (await locator.first().isVisible());
}

interface Collected {
  els: Element[];
  candidates: Candidate[];
}

export async function collectCandidates(
  page: Page,
  inputs: Record<string, string>,
): Promise<{ candidates: Candidate[]; element(i: number): Promise<ElementHandle<Element>>; dispose(): Promise<void> }> {
  // Element handles instead of marker attributes: the recorder watches the DOM,
  // and a marker could surface in a selector or a wait signal.
  const handle: JSHandle<Collected> = await page.evaluateHandle(
    ({ inputs, max }) => {
      const labelOf = (el: Element): string => {
        const id = el.getAttribute('id');
        const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
        return ((label as HTMLElement | null)?.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim();
      };
      const els: Element[] = [];
      const candidates: Candidate[] = [];
      const selector = 'button, a[href], [role="button"], [role="link"], [role="menuitem"], [role="tab"], input, select, textarea';
      for (const el of Array.from(document.querySelectorAll(selector))) {
        if (candidates.length >= max) break;
        const box = el.getBoundingClientRect();
        if (box.width === 0 || box.height === 0 || (el as HTMLButtonElement).disabled) continue;
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
          const label = labelOf(el);
          const value = inputs[label];
          if (value === undefined || (el as HTMLInputElement).type === 'password') continue;
          const current = tag === 'SELECT' ? (el as HTMLSelectElement).selectedOptions[0]?.text ?? '' : (el as HTMLInputElement).value;
          if (current === value) continue;
          candidates.push(
            tag === 'SELECT'
              ? { kind: 'select', value, desc: `choose "${value}" in the "${label}" field` }
              : { kind: 'fill', value, desc: `type "${value}" in the "${label}" field` },
          );
        } else {
          const name = (el.getAttribute('aria-label') || (el as HTMLElement).innerText || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
          if (!name) continue;
          const role = el.getAttribute('role') || (tag === 'A' ? 'link' : 'button');
          candidates.push({ kind: 'click', desc: `click ${role} "${name}"` });
        }
        els.push(el);
      }
      return { els, candidates };
    },
    { inputs, max: MAX_CANDIDATES },
  );
  const candidates = await handle.evaluate((c) => c.candidates);
  return {
    candidates,
    element: async (i) => (await handle.evaluateHandle((c, i) => c.els[i]!, i)) as ElementHandle<Element>,
    dispose: () => handle.dispose(),
  };
}

export async function readPageState(page: Page): Promise<{ current_path: string; headings: string[]; fields: Record<string, string>; messages: string[] }> {
  const inPage = await page.evaluate(() => {
    const labelOf = (el: Element): string => {
      const id = el.getAttribute('id');
      const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      return ((label as HTMLElement | null)?.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || id || '').trim();
    };
    const fields: Record<string, string> = {};
    for (const el of Array.from(document.querySelectorAll('input, select, textarea'))) {
      const input = el as HTMLInputElement;
      if (input.type === 'hidden') continue;
      fields[labelOf(el)] =
        input.type === 'password' ? '********' : el.tagName === 'SELECT' ? (el as HTMLSelectElement).selectedOptions[0]?.text ?? '' : input.value;
    }
    const texts = (sel: string) =>
      Array.from(document.querySelectorAll(sel)).map((e) => (e as HTMLElement).innerText.trim()).filter(Boolean);
    return { headings: texts('h1, h2'), fields, messages: texts('[role="status"], [role="alert"]') };
  });
  let currentPath = page.url();
  try {
    currentPath = new URL(currentPath).pathname;
  } catch {
    // about:blank and friends have no pathname worth sending.
  }
  return { current_path: currentPath, ...inPage };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/jev-page.test.ts`
Expected: PASS, 7 tests. If `url=about:blank` fails because `page.url()` is `about:blank` exactly, it passes by `includes`; if the 'offers visible enabled controls' order differs, fix the implementation to keep document order (the test encodes document order).

- [ ] **Step 5: Commit**

```bash
git add src/jev/page.ts tests/jev-page.test.ts
git commit -m "Read candidates and page state for Jev without touching the DOM"
```

---

### Task 4: Goal loop and record() integration

**Files:**
- Create: `src/jev/driver.ts`
- Modify: `src/api.ts` (RecordOptions, RecordResult, record(), exports)
- Test: `tests/jev-record.test.ts`

**Interfaces:**
- Consumes: `JevClient` (Task 2), `parseUntil`, `untilHolds`, `collectCandidates`, `readPageState` (Task 3), `resolveKey`, `NO_KEY_MESSAGE` (Task 1), `createJevClient` (Task 2).
- Produces:
  - `interface GoalOptions { goal: string; until: string; inputs?: Record<string, string>; maxSteps?: number }`
  - `class GoalNotReached extends Error { readonly reason: 'none' | 'max-steps'; readonly path: string[] }`
  - `goalDrive(options: GoalOptions, client: JevClient): { drive: (page: Page, api: DriveApi) => Promise<void>; path: string[] }`
  - `JEV_INSTRUCTIONS: string`
  - `RecordOptions.goal?: GoalOptions`, `RecordOptions.jev?: JevClient` (tests inject a fake)
  - `RecordResult.goalPath?: string[]`
  - api.ts re-exports: `GoalNotReached`, `JevError`, `NO_KEY_MESSAGE`, `type GoalOptions`, `type JevClient`

- [ ] **Step 1: Write the failing test**

```ts
// tests/jev-record.test.ts
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
    const replay = await run({ name: 'jev-add', root, headless: true });
    expect(replay.status).not.toBe('infrastructure');
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
    expect(result.repro.steps.filter((s) => s.action.type !== 'goto')).toHaveLength(0);
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
```

Before running, check `replay.status` values in `src/replayer/run.ts` (`RunResult`): if the field is named differently (for example `verdict` or `failure.kind`), change the assertion to "the replay did not fail with kind `infrastructure`" using the real field names. Also check the step shape in `src/ir/schema.ts`: if a step's action type lives under a different key than `s.action.type`, adjust the filter in 'asks nothing when until already holds'.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/jev-record.test.ts`
Expected: FAIL, `GoalNotReached` is not exported from `../src/api.js`.

- [ ] **Step 3: Write the goal loop**

```ts
// src/jev/driver.ts
import type { Page } from 'playwright';
import type { DriveApi } from '../recorder/launch.js';
import type { JevClient } from './client.js';
import { collectCandidates, parseUntil, readPageState, untilHolds } from './page.js';

export interface GoalOptions {
  goal: string;
  until: string;
  inputs?: Record<string, string>;
  maxSteps?: number;
}

export class GoalNotReached extends Error {
  constructor(
    readonly reason: 'none' | 'max-steps',
    readonly path: string[],
    maxSteps: number,
  ) {
    super(
      reason === 'none'
        ? 'Jev found no action toward the goal'
        : `stopped after ${maxSteps} steps without reaching --until`,
    );
    this.name = 'GoalNotReached';
  }
}

export const JEV_INSTRUCTIONS =
  'A user is operating a web app to accomplish `goal`. `fields` shows current form values and `messages` shows visible status text. ' +
  '`recent_actions` lists what was already done; an earlier click may need repeating if its effect is not visible yet. ' +
  'Which available action should happen next? Pick none only if no action serves the goal.';

const NONE = 'None of these actions moves closer to the goal, or the goal is not possible in this app';

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(300);
}

export function goalDrive(options: GoalOptions, client: JevClient): { drive: (page: Page, api: DriveApi) => Promise<void>; path: string[] } {
  const check = parseUntil(options.until);
  const maxSteps = options.maxSteps ?? 12;
  const taken: string[] = [];

  const drive = async (page: Page): Promise<void> => {
    await settle(page);
    for (let step = 0; ; step++) {
      if (await untilHolds(page, check)) return;
      if (step >= maxSteps) throw new GoalNotReached('max-steps', [...taken], maxSteps);
      const found = await collectCandidates(page, options.inputs ?? {});
      try {
        const criteria: Record<string, string> = { none: NONE };
        found.candidates.forEach((c, i) => (criteria[`c${i}`] = c.desc));
        const state = { goal: options.goal, ...(await readPageState(page)), recent_actions: [...taken] };
        // Act on the most probable option whatever its confidence: several fine next
        // actions split the probability, and only "none" winning means stop.
        const answer = await client.choice(state, JEV_INSTRUCTIONS, criteria);
        if (answer.choice === 'none' || !(answer.choice in criteria)) throw new GoalNotReached('none', [...taken], maxSteps);
        const index = Number(answer.choice.slice(1));
        const candidate = found.candidates[index]!;
        const el = await found.element(index);
        if (candidate.kind === 'click') await el.click();
        else if (candidate.kind === 'fill') await el.fill(candidate.value!);
        else await el.selectOption({ label: candidate.value! });
        taken.push(candidate.desc);
      } finally {
        await found.dispose();
      }
      await settle(page);
    }
  };

  return { drive, path: taken };
}
```

- [ ] **Step 4: Wire it into record()**

In `src/api.ts`:

Add imports near the other imports:

```ts
import { createJevClient, type JevClient } from './jev/client.js';
import { goalDrive, type GoalOptions } from './jev/driver.js';
import { NO_KEY_MESSAGE, resolveKey } from './jev/key.js';
```

Add to `RecordOptions` after `drive`:

```ts
  /**
   * Let Jev pick each next action until `until` holds. Mutually exclusive with
   * `drive`. Record time only: the IR it produces replays with no model.
   */
  goal?: GoalOptions;
  /** The Jev client to ask; defaults to one built from the resolved key. Tests pass a fake. */
  jev?: JevClient;
```

Add to `RecordResult`:

```ts
  /** The actions Jev took, in order, when recorded with `goal`. */
  goalPath?: string[];
```

At the top of `record()`, before `loadSteps`:

```ts
  if (options.goal && options.drive) throw new Error('record(): pass goal or drive, not both');
  let goalRun: ReturnType<typeof goalDrive> | null = null;
  if (options.goal) {
    let client = options.jev;
    if (!client) {
      const key = resolveKey();
      if (!key) throw new Error(NO_KEY_MESSAGE);
      client = createJevClient(key.key);
    }
    goalRun = goalDrive(options.goal, client);
  }
```

In the `launchRecording({...})` call replace `drive: options.drive,` with:

```ts
      drive: goalRun?.drive ?? options.drive,
```

Immediately after the `launchRecording` destructuring, before the storage-state block:

```ts
  // A goal that was not reached is not a repro: it never got to the bug, so
  // replaying it would read as fixed. Nothing is written.
  if (goalRun && driveError) throw driveError;
```

Change the final return to:

```ts
  return { repro, irPath: paths.ir, stopReason, session, warnings, ...(goalRun ? { goalPath: [...goalRun.path] } : {}) };
```

Add to the export block at the bottom of `src/api.ts`:

```ts
export { GoalNotReached, type GoalOptions } from './jev/driver.js';
export { JevError, type JevClient } from './jev/client.js';
export { NO_KEY_MESSAGE } from './jev/key.js';
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/jev-record.test.ts`
Expected: PASS, 7 tests. If the first test fails because the typed name is captured as per-keystroke steps, that is fine; the assertion is `>= 2`.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add src/jev/driver.ts src/api.ts tests/jev-record.test.ts
git commit -m "Record by goal: Jev picks each step until --until holds"
```

---

### Task 5: CLI flags, `repro jev`, first-run notice

**Files:**
- Create: `src/notice.ts`, `src/cli/jev.ts`
- Modify: `src/cli/index.ts` (record command, new `jev` command, `main()`)
- Test: `tests/notice.test.ts`, `tests/cli-jev.test.ts`

**Interfaces:**
- Consumes: `resolveKey`, `saveKey`, `deleteKey`, `credentialsPath`, `configDir`, `NO_KEY_MESSAGE` (Task 1); `createJevClient`, `JevError` (Task 2); `GoalNotReached` (Task 4).
- Produces:
  - `noticeText(version: string): string`
  - `shouldShowNotice(o: { version: string; env: NodeJS.ProcessEnv; isTTY: boolean }): boolean`
  - `markNoticeShown(version: string, env?: NodeJS.ProcessEnv): void`
  - `src/cli/jev.ts` exports `parseInputs(pairs: string[]): Record<string, string>`, `readSecret(prompt: string): Promise<string>` and `WHAT_IS_SENT: string[]`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/notice.test.ts
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { markNoticeShown, noticeText, shouldShowNotice } from '../src/notice.js';
import { saveKey } from '../src/jev/key.js';

let dir: string;
let env: NodeJS.ProcessEnv;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'notice-'));
  env = { XDG_CONFIG_HOME: dir };
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

describe('first-run notice', () => {
  it('shows once per version on a terminal', () => {
    expect(shouldShowNotice({ version: '1.0.0', env, isTTY: true })).toBe(true);
    markNoticeShown('1.0.0', env);
    expect(shouldShowNotice({ version: '1.0.0', env, isTTY: true })).toBe(false);
    expect(shouldShowNotice({ version: '1.1.0', env, isTTY: true })).toBe(true);
  });

  it('stays quiet off a terminal, with the opt-out, or with a key', () => {
    expect(shouldShowNotice({ version: '1.0.0', env, isTTY: false })).toBe(false);
    expect(shouldShowNotice({ version: '1.0.0', env: { ...env, FAST_REPLAY_NO_NOTICE: '1' }, isTTY: true })).toBe(false);
    expect(shouldShowNotice({ version: '1.0.0', env: { ...env, TYPESAFE_API_KEY: 'k' }, isTTY: true })).toBe(false);
    saveKey('k', env);
    expect(shouldShowNotice({ version: '1.0.0', env, isTTY: true })).toBe(false);
  });

  it('does not throw when the state file cannot be written or read', async () => {
    await mkdir(path.join(dir, 'fast-replay', 'state.json'), { recursive: true });
    expect(() => markNoticeShown('1.0.0', env)).not.toThrow();
    expect(() => shouldShowNotice({ version: '1.0.0', env, isTTY: true })).not.toThrow();
  });

  it('names the version, the command and the key step', () => {
    const text = noticeText('1.0.0');
    expect(text).toContain('fast-replay 1.0.0');
    expect(text).toContain('repro record --goal');
    expect(text).toContain('repro jev login');
    expect(text).not.toMatch(/[—–]/);
  });

  it('treats a broken credentials file as no key rather than crashing the notice', async () => {
    await mkdir(path.join(dir, 'fast-replay'), { recursive: true });
    await writeFile(path.join(dir, 'fast-replay', 'credentials.json'), '{nope', 'utf8');
    expect(shouldShowNotice({ version: '1.0.0', env, isTTY: true })).toBe(true);
  });
});
```

```ts
// tests/cli-jev.test.ts
import { describe, expect, it } from 'vitest';
import { parseInputs } from '../src/cli/jev.js';

describe('--input parsing', () => {
  it('splits on the first = only', () => {
    expect(parseInputs(['Report title=Weekly rollup', 'Note=a=b'])).toEqual({ 'Report title': 'Weekly rollup', Note: 'a=b' });
  });
  it('refuses a pair without =', () => {
    expect(() => parseInputs(['Title'])).toThrow(/--input "Title".*Label=value/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/notice.test.ts tests/cli-jev.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write `src/notice.ts`**

```ts
// src/notice.ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { configDir, resolveKey } from './jev/key.js';

export function noticeText(version: string): string {
  return [
    `fast-replay ${version}: optional Jev support. repro record --goal "..." finds the path`,
    'for you, about 0.3s per step against 2-5s for an LLM. Needs a TypeSafe key:',
    'repro jev login. Everything else works as before without it.',
  ].join('\n');
}

function statePath(env: NodeJS.ProcessEnv): string {
  return path.join(configDir(env), 'state.json');
}

function readState(env: NodeJS.ProcessEnv): { noticeShown?: string[] } {
  try {
    return JSON.parse(readFileSync(statePath(env), 'utf8')) as { noticeShown?: string[] };
  } catch {
    return {};
  }
}

export function shouldShowNotice(o: { version: string; env: NodeJS.ProcessEnv; isTTY: boolean }): boolean {
  if (!o.isTTY || o.env.FAST_REPLAY_NO_NOTICE) return false;
  try {
    if (resolveKey(o.env)) return false;
  } catch {
    // A broken credentials file is reported by the commands that need the key, not here.
  }
  return !(readState(o.env).noticeShown ?? []).includes(o.version);
}

export function markNoticeShown(version: string, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const state = readState(env);
    const shown = new Set(state.noticeShown ?? []);
    shown.add(version);
    mkdirSync(configDir(env), { recursive: true });
    writeFileSync(statePath(env), JSON.stringify({ ...state, noticeShown: [...shown] }, null, 2) + '\n');
  } catch {
    // An unwritable home directory must not break the command the user ran.
  }
}
```

- [ ] **Step 4: Write `src/cli/jev.ts`**

```ts
// src/cli/jev.ts
import readline from 'node:readline';

export const WHAT_IS_SENT = [
  'the goal text',
  'the URL path (no origin, no query)',
  'page headings',
  'names of visible buttons and links',
  'field labels and current values, passwords masked',
  'status messages',
  'the actions taken so far',
];

export function parseInputs(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    if (at <= 0) throw new Error(`--input "${pair}" is not Label=value`);
    out[pair.slice(0, at).trim()] = pair.slice(at + 1);
  }
  return out;
}

/** Reads piped stdin when there is one, otherwise prompts without echoing. */
export async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    let data = '';
    for await (const chunk of process.stdin) data += chunk;
    return data.trim();
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  process.stdout.write(prompt);
  // readline has no hidden mode; muting its echo is the standard workaround.
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
  const answer = await new Promise<string>((resolve) => rl.question('', resolve));
  rl.close();
  process.stdout.write('\n');
  return answer.trim();
}
```

- [ ] **Step 5: Run the unit tests**

Run: `npx vitest run tests/notice.test.ts tests/cli-jev.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Wire the CLI**

In `src/cli/index.ts`:

Add to the `../api.js` import list: `GoalNotReached`, `JevError`.
Add imports:

```ts
import { parseInputs, readSecret, WHAT_IS_SENT } from './jev.js';
import { createJevClient } from '../jev/client.js';
import { credentialsPath, deleteKey, resolveKey, saveKey } from '../jev/key.js';
import { markNoticeShown, noticeText, shouldShowNotice } from '../notice.js';
```

In the `record` command, after the `--headed` option add:

```ts
  .option('--goal <text>', 'let Jev walk to the bug: what the user is trying to do (needs a TypeSafe key)')
  .option('--until <check>', 'with --goal: selector, text=<visible text> or url=<part of the URL> that means reached')
  .option('--input <Label=value>', 'with --goal: a value Jev may type into the field with that label; repeatable', (v: string, acc: string[]) => [...acc, v], [] as string[])
  .option('--max-steps <n>', 'with --goal: give up after this many actions', '12')
```

At the start of the record action, before `const viewport`:

```ts
    if (opts.goal && opts.drive) throw new Error('--goal and --drive cannot be used together');
    if (opts.goal && !opts.until) throw new Error('--goal needs --until: a selector, text=<visible text> or url=<part of the URL>');
    const goal = opts.goal
      ? { goal: opts.goal as string, until: opts.until as string, inputs: parseInputs(opts.input as string[]), maxSteps: Number(opts.maxSteps) }
      : undefined;
```

In the `record({...})` call, replace the `...(driven ? ... : {})` spread with:

```ts
      ...(driven ? { drive: driven.drive, setup: driven.setup, headless: !opts.headed } : {}),
      ...(goal ? { goal, headless: !opts.headed } : {}),
```

Destructure `goalPath` from the result alongside `repro, irPath, ...`. In `onReady`, the driving line becomes:

```ts
          driven
            ? dim(`  Driving from ${path.relative(process.cwd(), path.resolve(opts.drive))}.`)
            : goal
              ? dim(`  Jev is walking to: ${goal.goal}`)
              : dim(`  Reproduce the bug, then press ${STOP_HOTKEY} — or just close the browser.`),
```

After the `→ irPath` line add:

```ts
    if (goalPath) console.log(`  ${dim('path')} ${goalPath.length ? goalPath.join(' → ') : 'already there, no actions'}`);
```

Add the `jev` command before `main()`:

```ts
const jev = program.command('jev').description('optional TypeSafe Jev key, used only by repro record --goal');

jev
  .command('login')
  .description('save a TypeSafe API key to your user config, never the project')
  .action(async () => {
    const key = await readSecret('TypeSafe API key: ');
    if (!key) throw new Error('No key given.');
    await createJevClient(key).choice({ check: 'connectivity' }, 'Is this a connectivity check?', { yes: 'yes', no: 'no' });
    console.log(`${green('✓')} Key works, saved to ${saveKey(key)}`);
  });

jev
  .command('logout')
  .description('delete the saved key')
  .action(() => {
    console.log(deleteKey() ? `${green('✓')} Removed ${credentialsPath()}` : dim('No saved key.'));
    if (process.env.TYPESAFE_API_KEY) console.log(yellow('  TYPESAFE_API_KEY is still set in this shell.'));
  });

jev
  .command('status')
  .description('where the key comes from, whether it works, and what is sent')
  .action(async () => {
    const key = resolveKey();
    if (!key) {
      console.log(`${dim('key')}    none. ${noticeText(VERSION).split('\n').slice(-2).join(' ')}`);
      return;
    }
    console.log(`${dim('key')}    from ${key.source === 'env' ? 'TYPESAFE_API_KEY' : credentialsPath()}`);
    const started = Date.now();
    try {
      await createJevClient(key.key).choice({ check: 'connectivity' }, 'Is this a connectivity check?', { yes: 'yes', no: 'no' });
      console.log(`${dim('api')}    ${green('ok')} in ${ms(Date.now() - started)}`);
    } catch (err) {
      console.log(`${dim('api')}    ${red((err as Error).message)}`);
      process.exitCode = 1;
    }
    console.log(dim('sent per step while recording with --goal, never at replay:'));
    for (const item of WHAT_IS_SENT) console.log(dim(`  - ${item}`));
  });
```

Check `ms` in `./format.js` takes a number of milliseconds; if its signature differs, print `${Date.now() - started}ms` instead.

In `main()`, before `await program.parseAsync(process.argv);`:

```ts
    if (shouldShowNotice({ version: VERSION, env: process.env, isTTY: Boolean(process.stdout.isTTY) })) {
      console.error(dim(noticeText(VERSION)) + '\n');
      markNoticeShown(VERSION);
    }
```

In `main()`'s catch, before the `PartialRecordingError` branch:

```ts
    if (err instanceof GoalNotReached) {
      console.error(`${yellow('!')} ${err.message}. Nothing was written.`);
      console.error(dim(`  tried: ${err.path.length ? err.path.join(' → ') : 'no actions'}`));
      process.exitCode = 1;
      return;
    }
    if (err instanceof JevError) {
      console.error(`${red('✗')} ${err.message} Nothing was written.`);
      process.exitCode = 1;
      return;
    }
```

- [ ] **Step 7: Typecheck, build, smoke test**

Run: `npm run typecheck && npm run build`
Expected: no errors.

Run: `env -u TYPESAFE_API_KEY XDG_CONFIG_HOME=$(mktemp -d) node dist/cli/index.js record x -u http://localhost:1 --goal "y" --until h1`
Expected: exits 1 with `--goal needs a TypeSafe key: set TYPESAFE_API_KEY or run repro jev login` (a non-TTY stdout means no notice).

Run: `node dist/cli/index.js record x -u http://localhost:1 --goal "y"`
Expected: `--goal needs --until: ...`

Run: `env -u TYPESAFE_API_KEY XDG_CONFIG_HOME=$(mktemp -d) node dist/cli/index.js jev status`
Expected: `key    none.` line naming `repro jev login`, exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/notice.ts src/cli/jev.ts src/cli/index.ts tests/notice.test.ts tests/cli-jev.test.ts
git commit -m "Add record --goal, repro jev login/logout/status and the first-run notice"
```

---

### Task 6: MCP `repro_record` goal fields and instructions

**Files:**
- Modify: `src/mcp/server.ts` (`createReplayServer` options, `repro_record`)
- Modify: `src/agent-notes.ts` (`AGENT_WORKFLOW` step 2, `buildInstructions`)
- Test: `tests/jev-mcp.test.ts`

**Interfaces:**
- Consumes: `GoalNotReached`, `JevError`, `NO_KEY_MESSAGE`, `JevClient`, `resolveKey` (Tasks 1, 2, 4).
- Produces: `createReplayServer(root?: string, options?: { jev?: JevClient }): Promise<ReplayServer>`; `buildInstructions(root: string): Promise<string>` now ends with a Jev line.

- [ ] **Step 1: Write the failing test**

```ts
// tests/jev-mcp.test.ts
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createReplayServer, reproPaths } from '../src/api.js';
import type { ChoiceAnswer, JevClient } from '../src/jev/client.js';
import { startDemoServer, type DemoServer } from './helpers/demo-server.js';

interface ToolResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
}

let server: DemoServer;
let root: string;
const saved = { key: process.env.TYPESAFE_API_KEY, xdg: process.env.XDG_CONFIG_HOME };

async function connect(jev?: JevClient) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  const replay = await createReplayServer(root, jev ? { jev } : {});
  await Promise.all([replay.server.connect(serverTransport), client.connect(clientTransport)]);
  const call = (args: Record<string, unknown>) => client.callTool({ name: 'repro_record', arguments: args }) as Promise<ToolResult>;
  return { client, replay, call };
}
const text = (r: ToolResult) => r.content.map((c) => c.text ?? '').join('\n');

beforeAll(async () => {
  server = await startDemoServer(5448);
  root = await mkdtemp(path.join(tmpdir(), 'replay-jev-mcp-'));
  delete process.env.TYPESAFE_API_KEY;
  process.env.XDG_CONFIG_HOME = root;
}, 60_000);
afterAll(async () => {
  if (saved.key !== undefined) process.env.TYPESAFE_API_KEY = saved.key;
  if (saved.xdg !== undefined) process.env.XDG_CONFIG_HOME = saved.xdg;
  else delete process.env.XDG_CONFIG_HOME;
  await server?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('repro_record with a goal', () => {
  it('says in the instructions whether a Jev key is set', async () => {
    const { client, replay } = await connect();
    expect(client.getInstructions()).toMatch(/Jev: no key set/);
    await replay.dispose();
    await client.close();
  });

  it('refuses a goal without a key', async () => {
    const { client, replay, call } = await connect();
    const result = await call({ name: 'g1', url: server.baseUrl, goal: 'x', until: 'h1' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('--goal needs a TypeSafe key');
    await replay.dispose();
    await client.close();
  });

  it('refuses neither or both of drive and goal', async () => {
    const { client, replay, call } = await connect();
    expect(text(await call({ name: 'g2', url: server.baseUrl }))).toMatch(/exactly one of drive or goal/);
    expect(text(await call({ name: 'g2', url: server.baseUrl, drive: 'a.mjs', goal: 'x', until: 'h1' }))).toMatch(/exactly one of drive or goal/);
    expect(text(await call({ name: 'g2', url: server.baseUrl, goal: 'x' }))).toMatch(/goal needs until/);
    await replay.dispose();
    await client.close();
  });

  it('records with an injected client and reports the path', async () => {
    await fetch(`${server.baseUrl}/api/reset`, { method: 'POST' });
    const picks = ['click button "Reports"'];
    const jev: JevClient = {
      async choice(_s, _i, criteria): Promise<ChoiceAnswer> {
        const want = picks.shift() ?? 'none';
        const key = Object.keys(criteria).find((k) => criteria[k] === want) ?? 'none';
        return { choice: key, confidence: 0.9, probabilities: { [key]: 0.9 } };
      },
    };
    const { client, replay, call } = await connect(jev);
    const result = await call({ name: 'g3', url: server.baseUrl, goal: 'Open reports', until: 'url=/reports' });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toMatch(/Path: click button "Reports"/);
    await replay.dispose();
    await client.close();
  });

  it('writes nothing when the goal is not reached', async () => {
    const jev: JevClient = { async choice() { return { choice: 'none', confidence: 0.9, probabilities: { none: 0.9 } }; } };
    const { client, replay, call } = await connect(jev);
    const result = await call({ name: 'g4', url: server.baseUrl, goal: 'Change password', until: 'text=Done' });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Jev found no action toward the goal/);
    expect(existsSync(reproPaths('g4', root).ir)).toBe(false);
    await replay.dispose();
    await client.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/jev-mcp.test.ts`
Expected: FAIL, instructions lack `Jev: no key set` and the goal arguments are rejected by the schema.

- [ ] **Step 3: Update `src/agent-notes.ts`**

In `AGENT_WORKFLOW`, after the line ending `instead of signing in again.` in step 2, add one line (keep the template literal's indentation style):

```
   With a TypeSafe key set, repro_record also takes goal, until and inputs instead of a drive file: Jev picks each click while recording, until is checked by code, and nothing is saved unless it holds. Replay never uses a model.
```

Change `buildInstructions`:

```ts
export async function buildInstructions(root: string): Promise<string> {
  let jev = 'Jev: no key set, so repro_record needs a drive file.';
  try {
    if (resolveKey()) jev = 'Jev: key set, so repro_record accepts goal, until and inputs.';
  } catch {
    // A broken credentials file surfaces when a goal recording asks for the key.
  }
  return `${AGENT_WORKFLOW}\n\n${await renderProjectSnapshot(root)}\n\n${jev}`;
}
```

with `import { resolveKey } from './jev/key.js';` at the top.

- [ ] **Step 4: Update `src/mcp/server.ts`**

Change the signature to `createReplayServer(root = process.cwd(), options: { jev?: JevClient } = {})` and import `GoalNotReached`, `JevError`, `type JevClient` from `../api.js` (or their modules, matching how the file already imports from api).

In `repro_record`'s `description`, append: `' Or, with a TypeSafe key set, pass goal, until and inputs instead of drive: Jev picks each action while recording; nothing is saved unless until holds.'`

Replace `drive: z.string().describe(...)` with:

```ts
        drive: z.string().optional().describe('Path to the drive file, relative to the project root or absolute. Exactly one of drive or goal.'),
        goal: z.string().optional().describe('What the user is trying to do; Jev picks each action. Needs a TypeSafe key. Exactly one of drive or goal.'),
        until: z.string().optional().describe('With goal: selector, text=<visible text> or url=<part of the URL> that means the goal is reached.'),
        inputs: z.record(z.string(), z.string()).optional().describe('With goal: field label to the value Jev may type there.'),
```

Handler signature: `async ({ name, url, drive, goal, until, inputs, start_path, headed, viewport }) => {`. Replace the `loadDrive` block with:

```ts
      if (Boolean(drive) === Boolean(goal)) return refuse('Pass exactly one of drive or goal.');
      if (goal && !until) return refuse('goal needs until: a selector, text=<visible text> or url=<part of the URL>.');

      let driven: Awaited<ReturnType<typeof loadDrive>> | null = null;
      if (drive) {
        try {
          driven = await loadDrive(path.resolve(root, drive));
        } catch (err) {
          return refuse((err as Error).message);
        }
      }
```

In the `record({...})` call replace `drive: driven.drive, setup: driven.setup,` with:

```ts
          ...(driven ? { drive: driven.drive, setup: driven.setup } : { goal: { goal: goal!, until: until!, inputs: inputs ?? {} }, ...(options.jev ? { jev: options.jev } : {}) }),
```

In the catch, before the `PartialRecordingError` check:

```ts
        if (err instanceof GoalNotReached) {
          return refuse(`${err.message}. Nothing was written.\nTried: ${err.path.length ? err.path.join(' → ') : 'no actions'}`);
        }
```

(`JevError` and the no-key error fall through to the existing `refuse((err as Error).message)`.)

After the `IR:` line of the success branch, add:

```ts
      if (result?.goalPath) lines.push(`Path: ${result.goalPath.length ? result.goalPath.join(' → ') : 'already there, no actions'}`);
```

Make sure `createServer(root)` still calls `createReplayServer(root)`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/jev-mcp.test.ts tests/mcp.test.ts tests/init.test.ts`
Expected: PASS. The existing `mcp.test.ts` instructions test only uses `toContain`/`toMatch`, so the appended Jev line does not break it.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/server.ts src/agent-notes.ts tests/jev-mcp.test.ts
git commit -m "Let repro_record take a goal, and tell agents whether a Jev key is set"
```

---

### Task 7: Live test against the real API

**Files:**
- Test: `tests/jev-live.test.ts`

**Interfaces:**
- Consumes: `record`, `run` (api), real key via `resolveKey`.

- [ ] **Step 1: Write the test**

```ts
// tests/jev-live.test.ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { record } from '../src/api.js';
import { startDemoServer, type DemoServer } from './helpers/demo-server.js';

// Costs real API calls, so it runs only when a key is in the environment.
describe.skipIf(!process.env.TYPESAFE_API_KEY)('Jev against the real API', () => {
  let server: DemoServer;
  let root: string;
  beforeAll(async () => {
    server = await startDemoServer(5448);
    root = await mkdtemp(path.join(tmpdir(), 'replay-jev-live-'));
  }, 60_000);
  afterAll(async () => {
    await server?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('adds a sensor by goal', async () => {
    await fetch(`${server.baseUrl}/api/reset`, { method: 'POST' });
    const result = await record({
      name: 'live-add',
      baseUrl: server.baseUrl,
      root,
      headless: true,
      goal: { goal: 'Add a new sensor named Boiler inlet', until: 'text=Boiler inlet', inputs: { 'New sensor name': 'Boiler inlet' } },
    });
    expect(result.goalPath).toContain('click button "Add sensor"');
  });

  it('generates a report by goal', async () => {
    await fetch(`${server.baseUrl}/api/reset`, { method: 'POST' });
    const result = await record({
      name: 'live-report',
      baseUrl: server.baseUrl,
      root,
      headless: true,
      goal: {
        goal: 'Generate a report titled Weekly rollup for Sensor 3',
        until: '[data-testid="report-result"]',
        inputs: { 'Report title': 'Weekly rollup', Sensor: 'Sensor 3' },
      },
    });
    expect(result.goalPath).toContain('click button "Generate report"');
  });
});
```

- [ ] **Step 2: Run it both ways**

Run: `npx vitest run tests/jev-live.test.ts`
Expected: 2 skipped (no key in env).

Run: `set -a && . ~/.typesafe.env && set +a && npx vitest run tests/jev-live.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 3: Commit**

```bash
git add tests/jev-live.test.ts
git commit -m "Live Jev test, skipped without a key"
```

---

### Task 8: Docs, version 1.0.0, full verification

**Files:**
- Modify: `package.json`, `package-lock.json` (version), `CHANGELOG.md`, `README.md`, `CLAUDE.md`

- [ ] **Step 1: Bump the version**

Run: `npm version 1.0.0 --no-git-tag-version`
Expected: `v1.0.0`; `package.json` and `package-lock.json` both say `1.0.0` at the top level.

- [ ] **Step 2: CLAUDE.md rule**

In `CLAUDE.md` under "Design principles that constrain changes", replace the first bullet with:

```
- **No model calls at replay.** Replay, the verdict and the IR are deterministic; nothing under `src/replayer/` imports `src/jev/` (a test enforces it). The one model call is optional and record-time only: `record --goal` asks Jev (`src/jev/`) for the next action when a TypeSafe key is set. Anything else requiring judgement belongs to the caller.
```

In the Architecture section, after the "Drive files" paragraph, add:

```
**Jev** (`src/jev/`): optional, record time only. `key.ts` resolves `TYPESAFE_API_KEY` or `~/.config/fast-replay/credentials.json`; `client.ts` calls the TypeSafe API over `fetch`; `page.ts` reads candidates as element handles (never writing to the DOM the recorder watches) and the page state with passwords masked; `driver.ts` turns a goal into an ordinary `drive` function. A goal that does not reach `--until` writes nothing. `src/notice.ts` prints the once-per-version first-run notice.
```

- [ ] **Step 3: CHANGELOG**

Add at the top of `CHANGELOG.md`, under `# Changelog`:

```markdown
## 1.0.0 — 2026-09-24

### Record by goal, optionally with Jev

Walking to a bug is the slow part of recording: a person has to start, and an LLM agent spends seconds per step deciding which button comes next. With a TypeSafe key set, `repro record <name> -u <url> --goal "..." --until <check>` lets Jev, TypeSafe's System One model, pick each click, fill or select from what is on screen. `--until` (a selector, `text=...` or `url=...`) is checked by code after every step; the recording is saved only when it holds, so a run that never reached the bug cannot read as fixed later. Jev types only the values given with `--input "Label=value"`. `repro_record` takes the same `goal`, `until` and `inputs` fields.

On the demo app, six goals three times each, Jev, Haiku and Sonnet all reached 18 of 18 and refused the impossible goal; the median decision took 343 ms with Jev against 1.7 s (Sonnet) and 4.3 s (Haiku) at the API.

The rule changes from "no model calls anywhere" to "no model calls at replay". The IR is unchanged and a repro recorded by goal replays with no key.

Per step, the goal, URL path, headings, control names, field labels and values (passwords masked), status text and actions so far go to `api.typesafe.ai`. Nothing is sent at replay or without a key.

`repro jev login` saves the key to `~/.config/fast-replay/credentials.json` (mode 0600, never the project); `TYPESAFE_API_KEY` wins over it. `repro jev status` shows where the key comes from, pings the API and lists what is sent. `repro jev logout` removes it.

The first `repro` command after an install or update prints a three-line note about this, once per version, on a terminal, and not when a key is already set or `FAST_REPLAY_NO_NOTICE=1`. There is no postinstall script.

Without a key nothing changes, and no dependency was added.
```

- [ ] **Step 4: README**

In `README.md`, at the end of the `## From a coding agent` section (after the paragraph that ends `Works with Claude Code, Codex, Gemini CLI, Cursor.`), add:

````markdown
### Let Jev walk to the bug (optional)

With a [TypeSafe](https://typesafe.ai) key, recording can start from a goal instead of a script:

```bash
repro jev login
repro record report-bug -u http://localhost:5173 \
  --goal "Generate a report titled Weekly rollup" \
  --until '[data-testid="report-result"]' --input "Report title=Weekly rollup"
```

Jev picks each step in about 0.3 s; `--until` is checked by code and nothing is saved unless it holds. Replay never calls a model. Without a key everything works as before. What is sent: `repro jev status`.
````

- [ ] **Step 5: Full verification**

Run: `npm run typecheck && npm run build && npm test`
Expected: typecheck clean, build clean, all tests pass (the live file skipped unless the key is in the environment). Paste the summary line of the test run into the task report.

Run: `set -a && . ~/.typesafe.env && set +a && npx vitest run tests/jev-live.test.ts`
Expected: PASS, 2 tests.

Run: `npm pack --dry-run 2>&1 | grep -E 'jev|notice|version'`
Expected: `dist/jev/*.js` and `dist/notice.js` listed, version 1.0.0.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json CHANGELOG.md README.md CLAUDE.md
git commit -m "Release 1.0.0: optional goal-driven recording with Jev"
```

- [ ] **Step 7: Stop for approval**

Do not tag, push or publish. Report to Mukher and wait for an explicit yes before: `git tag -a v1.0.0 -m "fast-replay 1.0.0"`, pushing the branch and tag, merging to main, and `npm publish`.
