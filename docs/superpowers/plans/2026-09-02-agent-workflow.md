# Agent Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a coding agent record a repro through the MCP server, share one signed-in session across every repro in a project with self-healing on expiry, keep shared steps committed while repros stay disposable, nudge toward extraction at a configured threshold, and hand the agent the project's state before its first tool call.

**Architecture:** Five additions on the existing record → compile → IR → replay pipeline. A `sessions` module owns project session files and one `establishSession` routine used by both recorder and replayer. A `drive` module loads agent-written drive files for the CLI and a new `repro_record` MCP tool. A `config` module and `repro init` split `.repros/` into committed and ignored halves. An `agent-notes` module renders the workflow text shared by `repro init` and the MCP `instructions`. The extraction nudge reuses `suggestExtractions` with the configured threshold.

**Tech Stack:** TypeScript (ESM, Node >= 20), Playwright, zod v4, commander, `@modelcontextprotocol/sdk`, vitest. Integration tests drive `examples/demo-app` (Vite + React) in a real Chromium.

**Spec:** `docs/superpowers/specs/2026-09-02-agent-workflow-design.md`

## Global Constraints

- No model calls anywhere in the tool. Anything needing judgement stays with the caller.
- Refuse rather than guess: a broken preamble or an unverifiable session reports `COULD NOT VERIFY`, never a verdict on the bug.
- The IR stays hand-editable JSON. `IR_VERSION` stays `1`; every new field is optional and backward-readable.
- Nothing probes a session without proof: record time probes only a start path listed in the session's `provenPaths`; replay probes only a repro carrying `sessionCheck`.
- A heal is never silent and happens at most once per run.
- Suggest never writes. Extraction is applied only by an explicit, caller-named call.
- Session files (`.repros/sessions/`) are never committed. Credentials come from env inside a step's own code.
- Comments state design rationale only, no restating the next line, no banner comments, no em dashes, one or two sentences.
- Commit messages: imperative title, body in the house style (what was wrong, what changed, the trade). End every commit with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01BgVy4HW385PjgtJLmbc6E8
  ```
- Work on branch `agent-workflow`. Tests run with `npx vitest run <file>`; the whole suite with `npm test`; types with `npm run typecheck`. Integration tests need `npx playwright install chromium` and `npm ci --prefix examples/demo-app` done once.
- Ports already used by test files: 5199 (default), 5240 (mcp), 5441 (steps), 5443 (extract). New files use 5445, 5446, 5447, 5448.

## File structure

New:
- `src/config.ts`: `ConfigSchema`, `Config`, `DEFAULT_CONFIG`, `CONFIG_FILE`, `loadConfig(root)`.
- `src/import-fresh.ts`: `importFresh(file)`, an ESM import that sees edits in a long-lived process.
- `src/sessions.ts`: session keys and files, meta sidecar, `planSession`, `establishSession`, `replaySessionTarget`.
- `src/drive.ts`: `defineDrive`, `DriveDefinition`, `loadDrive(file)`.
- `src/agent-notes.ts`: `AGENT_WORKFLOW`, `MCP_CONFIG_SNIPPET`, `renderProjectSnapshot(root)`, `buildInstructions(root)`.
- `src/init.ts`: `GITIGNORE_BLOCK`, `initProject(root)`.
- Tests: `tests/config.test.ts`, `tests/import-fresh.test.ts`, `tests/sessions-plan.test.ts`, `tests/sessions.test.ts`, `tests/drive.test.ts`, `tests/init.test.ts`.

Modified:
- `src/ir/io.ts`: reserved names, `config.json` not a repro, `drive` path, `deleteRepro` removes the drive file.
- `src/ir/schema.ts`: optional `sessionCheck`.
- `src/compiler/compile.ts`: `sessionCheck` passthrough.
- `src/steps.ts`: `loadSteps` imports through `importFresh`.
- `src/recorder/launch.ts`: declared `setup`, session plan, `browser`, returns `session` and `warnings`.
- `src/api.ts`: `RecordOptions.setup/browser`, `record()` uses `planSession`, `RecordResult.session/warnings`, new exports.
- `src/replayer/run.ts`: probe and heal for `sessionCheck` repros; `resolveSessionSeed` prefers the target host's file.
- `src/extract.ts`: `extractionNudge(root)`.
- `src/cli/index.ts`: `init`, `record --drive/--headed`, session line and nudge in `record`, nudge in `list`.
- `src/mcp/server.ts`: async creation with `instructions`, `repro_record`, nudge in `repro_list`, `repro_steps` warning text.
- `src/mcp/index.ts`: awaits the async creation.
- `examples/demo-app/src/App.tsx`: `signed-in-badge`.
- `tests/steps.test.ts`, `tests/mcp.test.ts`, `tests/unit.test.ts`: fixture and assertion updates.
- `README.md`, `CLAUDE.md`, `CHANGELOG.md`, `package.json` (0.13.0), the spec (host slug line).

---

### Task 1: Project config, and names the layout reserves

**Files:**
- Create: `src/config.ts`
- Modify: `src/ir/io.ts:20-31` (`assertValidName`), `src/ir/io.ts:122-131` (`listRepros`)
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(root?: string): Promise<Config>` where `Config = { extractThreshold: number }`; `DEFAULT_CONFIG`; `CONFIG_FILE = '.repros/config.json'`. `assertValidName` throws on `config`, `steps`, `sessions`, `drive`. `listRepros` ignores `config.json`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/config.test.ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG_FILE, DEFAULT_CONFIG, loadConfig } from '../src/config.js';
import { assertValidName, listRepros } from '../src/ir/io.js';

/**
 * The one committed settings file. Missing means defaults; anything invalid
 * names the file and the field, because a silently ignored threshold would
 * make the nudge look broken for no visible reason.
 */

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'replay-config-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const writeConfig = async (body: string): Promise<void> => {
  await mkdir(path.join(root, '.repros'), { recursive: true });
  await writeFile(path.join(root, CONFIG_FILE), body, 'utf8');
};

describe('project config', () => {
  it('defaults when the file is missing', async () => {
    expect(await loadConfig(root)).toEqual({ extractThreshold: 4 });
    expect(DEFAULT_CONFIG.extractThreshold).toBe(4);
  });

  it('reads a threshold', async () => {
    await writeConfig('{ "extractThreshold": 6 }');
    expect((await loadConfig(root)).extractThreshold).toBe(6);
  });

  it('names the field when a value is invalid', async () => {
    await writeConfig('{ "extractThreshold": 1 }');
    await expect(loadConfig(root)).rejects.toThrow(/extractThreshold/);
  });

  it('names the file when it is not JSON', async () => {
    await writeConfig('{ nope');
    await expect(loadConfig(root)).rejects.toThrow(/config\.json/);
  });

  it('is not listed as a repro', async () => {
    await writeConfig('{}');
    expect(await listRepros(root)).toEqual([]);
  });

  it('reserves the names the layout uses', () => {
    for (const name of ['config', 'steps', 'sessions', 'drive']) {
      expect(() => assertValidName(name)).toThrow(/reserved/);
    }
    expect(() => assertValidName('checkout-crash')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL, `Cannot find module '../src/config.js'`.

- [ ] **Step 3: Create the config module**

```ts
// src/config.ts
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { REPROS_DIR } from './ir/io.js';

/**
 * Project settings, committed alongside the shared steps.
 *
 * Deliberately one field. Repros are disposable and sessions hold tokens, so
 * this file is the only thing under .repros/ besides steps that a team shares,
 * and every field added here is a decision every project has to make.
 */
export const ConfigSchema = z.object({
  /** How many repros must share a prefix before the tool suggests extracting it. */
  extractThreshold: z.number().int().min(2).default(4),
});
export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: Config = ConfigSchema.parse({});
export const CONFIG_FILE = path.join(REPROS_DIR, 'config.json');

export async function loadConfig(root = process.cwd()): Promise<Config> {
  const file = path.join(root, CONFIG_FILE);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return DEFAULT_CONFIG;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = ConfigSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid ${CONFIG_FILE}\n${issues}`);
  }
  return parsed.data;
}
```

- [ ] **Step 4: Reserve layout names and skip the config file in listings**

In `src/ir/io.ts`, replace `assertValidName` and the `names` line in `listRepros`:

```ts
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Subdirectories and files that .repros/ holds besides repros. A repro with one
 * of these names would write its IR over the config or its sidecar dir over
 * the steps.
 */
const RESERVED_NAMES = new Set(['config', 'steps', 'sessions', 'drive']);

/**
 * Repro names become path segments, so reject anything that could escape the
 * .repros directory or collide with the sidecar-dir convention.
 */
export function assertValidName(name: string): void {
  if (!NAME_RE.test(name) || name.includes('..')) {
    throw new Error(
      `Invalid repro name "${name}". Use letters, digits, dot, dash and underscore; must start alphanumeric.`,
    );
  }
  if (RESERVED_NAMES.has(name.toLowerCase())) {
    throw new Error(`"${name}" is reserved for the .repros/ layout and cannot name a repro.`);
  }
}
```

```ts
  const names = entries
    .filter((e) => e.endsWith('.json') && !RESERVED_NAMES.has(e.slice(0, -'.json'.length)))
    .map((e) => e.slice(0, -'.json'.length));
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/ir/io.ts tests/config.test.ts
git commit -m "Add a committed project config and reserve the names .repros/ needs

.repros/config.json carries the extraction threshold. Its name, and the
steps, sessions and drive directories, can no longer be taken by a repro.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BgVy4HW385PjgtJLmbc6E8"
```

---

### Task 2: Import user modules fresh in a long-lived process

**Files:**
- Create: `src/import-fresh.ts`
- Modify: `src/steps.ts:726-742` (`loadSteps` import)
- Test: `tests/import-fresh.test.ts`

**Interfaces:**
- Produces: `importFresh<T>(file: string): Promise<T>`. `loadSteps` picks up an edited step file within one process.

- [ ] **Step 1: Write the failing test**

```ts
// tests/import-fresh.test.ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importFresh } from '../src/import-fresh.js';
import { loadSteps } from '../src/steps.js';

/**
 * Node caches an ES module by URL for the life of the process. The MCP server
 * is that process, and "edit the step, run again" must run the edit.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'replay-fresh-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

describe('importFresh', () => {
  it('sees an edit made after the first import', async () => {
    const file = path.join(dir, 'm.mjs');
    await writeFile(file, 'export default 1;', 'utf8');
    expect((await importFresh<{ default: number }>(file)).default).toBe(1);
    await settle();
    await writeFile(file, 'export default 2;', 'utf8');
    expect((await importFresh<{ default: number }>(file)).default).toBe(2);
  });

  it('is what loadSteps uses, so a fixed step is the step that runs', async () => {
    const file = path.join(dir, 's.mjs');
    await writeFile(
      file,
      `export default { name: 's', description: 'one', async run() {} };`,
      'utf8',
    );
    expect((await loadSteps(dir)).steps.get('s')?.description).toBe('one');
    await settle();
    await writeFile(
      file,
      `export default { name: 's', description: 'two', async run() {} };`,
      'utf8',
    );
    expect((await loadSteps(dir)).steps.get('s')?.description).toBe('two');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/import-fresh.test.ts`
Expected: FAIL, `Cannot find module '../src/import-fresh.js'`.

- [ ] **Step 3: Create the module and use it in loadSteps**

```ts
// src/import-fresh.ts
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Import a user module, seeing edits made since the last import.
 *
 * Node caches an ES module by URL for the life of the process. The MCP server
 * is long-lived, so a step or drive file edited between two calls would keep
 * running its first version. The file's mtime and size in the query string
 * make an edited file a new URL and an unchanged one the same URL.
 */
export async function importFresh<T = unknown>(file: string): Promise<T> {
  const abs = path.resolve(file);
  const { mtimeMs, size } = await stat(abs);
  const url = pathToFileURL(abs);
  url.searchParams.set('v', `${mtimeMs}-${size}`);
  return (await import(url.href)) as T;
}
```

In `src/steps.ts`, replace the `pathToFileURL` import with `import { importFresh } from './import-fresh.js';` and replace the import inside the loop:

```ts
      const mod = await importFresh<{ default?: StepDefinition }>(file);
```

Remove the now unused `import { pathToFileURL } from 'node:url';`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/import-fresh.test.ts tests/steps.test.ts`
Expected: PASS. The steps suite is the regression guard; it boots the demo app and takes a minute.

- [ ] **Step 5: Commit**

```bash
git add src/import-fresh.ts src/steps.ts tests/import-fresh.test.ts
git commit -m "Import step files fresh, so an edit reaches a running MCP server

Node caches an ES module by URL for the life of the process. In the long-lived
server a step fixed between two calls kept running its first version, which
made the fix-the-step-once story false exactly where it matters.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BgVy4HW385PjgtJLmbc6E8"
```

---

### Task 3: `sessionCheck` in the IR and the compiler

**Files:**
- Modify: `src/ir/schema.ts:196-225` (`ReproSchema`), `src/compiler/compile.ts:14-23` (`CompileOptions`) and `src/compiler/compile.ts:229-236` (output object)
- Test: `tests/unit.test.ts` (append a describe)

**Interfaces:**
- Produces: `Repro.sessionCheck?: { step: string }`; `CompileOptions.sessionCheck?: { step: string }`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit.test.ts`:

```ts
describe('sessionCheck', () => {
  const base = {
    version: 1,
    name: 'x',
    createdAt: '2026-01-01T00:00:00.000Z',
    baseUrl: BASE,
    viewport: { width: 1, height: 1 },
    steps: [],
    assertion: { finalState: {}, invariants: {} },
  };

  it('is optional, so a repro from an earlier release still parses', () => {
    expect(parseRepro(base, 'x.json').sessionCheck).toBeUndefined();
    expect(parseRepro({ ...base, sessionCheck: { step: 'signed-in' } }, 'x.json').sessionCheck).toEqual({
      step: 'signed-in',
    });
  });

  it('is written by compile only when given', () => {
    const t = trace();
    expect(compile(t, { name: 'x', storageStatePath: null }).sessionCheck).toBeUndefined();
    expect(
      compile(t, { name: 'x', storageStatePath: null, sessionCheck: { step: 's' } }).sessionCheck,
    ).toEqual({ step: 's' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit.test.ts -t sessionCheck`
Expected: FAIL, the compile test: type error or `undefined` where `{ step: 's' }` is expected.

- [ ] **Step 3: Add the field to the schema and the compiler**

In `src/ir/schema.ts`, inside `ReproSchema` after `setup`:

```ts
  /**
   * Verify this step's `ensures` on the start path before trusting the
   * restored session, and re-run the step once if it is not visible.
   *
   * Written only when record time proved the check works for this repro: the
   * selector was visible on the start path right after a real sign-in. A probe
   * on a path where it is never visible would time out and sign in on every
   * replay, which is the failure a shared session exists to remove. Absent
   * means restore and skip, as before.
   */
  sessionCheck: z.object({ step: z.string().min(1) }).optional(),
```

In `src/compiler/compile.ts`, add to `CompileOptions`:

```ts
  /** Present only when record time proved the session probe on this start path. */
  sessionCheck?: { step: string };
```

and in the returned object, after `setup: options.setup ?? [],`:

```ts
    ...(options.sessionCheck ? { sessionCheck: options.sessionCheck } : {}),
```

- [ ] **Step 4: Run the tests and the type check**

Run: `npx vitest run tests/unit.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/ir/schema.ts src/compiler/compile.ts tests/unit.test.ts
git commit -m "Add sessionCheck to the IR

An optional marker meaning the restored session may be verified against a
named step's ensures on the start path. Absent, replay behaves as before, so
the IR version stays at 1.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BgVy4HW385PjgtJLmbc6E8"
```

---

### Task 4: A session the demo app can actually show

**Files:**
- Modify: `examples/demo-app/src/App.tsx:18-45` (header)
- Modify: `tests/steps.test.ts:59-72` (the `session` step fixture)

**Interfaces:**
- Produces: `[data-testid="signed-in-badge"]`, rendered on every route when `localStorage.replay-token === 'ok'`. The `session` step's `ensures` is that badge.

- [ ] **Step 1: Change the fixture so the existing session tests need the badge**

In `tests/steps.test.ts`, replace the `session` step body:

```ts
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
```

- [ ] **Step 2: Run the session tests to verify they fail**

Run: `npx vitest run tests/steps.test.ts -t "session step runs once"`
Expected: FAIL, the step times out waiting for `signed-in-badge`.

- [ ] **Step 3: Render the badge**

In `examples/demo-app/src/App.tsx`, inside `App()` before the `return`:

```tsx
  // Read once at mount, like an app that decodes its token on boot. The tests'
  // sign-in step reloads after setting it, the way a real sign-in lands on a
  // fresh document.
  const [signedIn] = useState(() => {
    try {
      return localStorage.getItem('replay-token') === 'ok';
    } catch {
      return false;
    }
  });
```

and inside `<header className="topbar">`, after `</nav>`:

```tsx
        {signedIn && (
          <span className="badge" data-testid="signed-in-badge">
            signed in
          </span>
        )}
```

- [ ] **Step 4: Assert that a navigating setup step leaves no goto step behind**

In `tests/steps.test.ts`, inside the test `captures the session at record and skips the step on every replay`, change the `record` call to keep its result and add an assertion right after the `__sessionRuns` check:

```ts
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
```

Run: `npx vitest run tests/steps.test.ts -t "captures the session"`
Expected: FAIL, the IR contains a `goto` step. `framenavigated` is recorded even while capture is suspended, and an unattributed navigation with a document load compiles to `goto`.

- [ ] **Step 5: Gate navigation capture on suspend**

In `src/recorder/attach.ts`, inside `watchPage`:

```ts
  const watchPage = (page: Page): void => {
    page.on('framenavigated', (frame: Frame) => {
      // Setup runs while capture is suspended, and a sign-in that navigates
      // would otherwise compile to a goto step nobody recorded.
      if (suspended || frame !== page.mainFrame()) return;
      navigations.push({ kind: 'navigation', url: frame.url(), t: Date.now() });
    });
    // Fires only when a new document is actually parsed, so it distinguishes a
    // real navigation from client-side routing.
    page.on('domcontentloaded', () => {
      if (suspended) return;
      documentLoads.push(Date.now());
    });
  };
```

- [ ] **Step 6: Run the steps suite to verify it passes**

Run: `npx vitest run tests/steps.test.ts`
Expected: PASS, all tests. The badge is in the header, so it is visible on `/` and `/reports`.

- [ ] **Step 7: Commit**

```bash
git add examples/demo-app/src/App.tsx src/recorder/attach.ts tests/steps.test.ts
git commit -m "Give the demo app a signed-in badge the session tests can check

The session fixture wrote a token nothing read, so its ensures held whether or
not a session existed. A badge on every route makes a stale token visible.
Navigations are no longer captured while setup runs, so a sign-in that reloads
stops leaving a goto step in the IR.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BgVy4HW385PjgtJLmbc6E8"
```

---

### Task 5: Session keys, files, meta and the record-time plan

**Files:**
- Create: `src/sessions.ts`
- Test: `tests/sessions-plan.test.ts`

**Interfaces:**
- Produces (all in `src/sessions.ts`):
  - `SESSIONS_DIR = '.repros/sessions'`
  - `sessionKey(step: string, params?: Record<string, string>): string`
  - `hostSlug(url: string): string` (the URL's `host` with `:` written as `_`)
  - `sessionFiles(root: string, key: string, host: string): SessionFiles` where `SessionFiles = { state: string; meta: string | null }`
  - `parseSessionPath(statePath: string): { key: string; host: string } | null`
  - `SessionMeta = { mintedAt: string; provenPaths: string[] }`, `readMeta(file: string | null): SessionMeta`, `readSessionState(file: string): StorageState | null`
  - `persistSession(files: SessionFiles, state: string, proof: { path: string; proven: boolean }): Promise<void>`
  - `SessionTarget = { step: LoadedStep; params: Record<string,string>; key: string; host: string; files: SessionFiles }`
  - `SessionPlan = { target: SessionTarget | null; seedPath: string | null; probe: boolean; disabled: string | null }`
  - `planSession(o: { root; baseUrl; startPath; setup; steps; explicitSeed: 'storage-state' | 'profile' | null }): SessionPlan`
- Consumes: `REPROS_DIR`, `writeFileAtomic` from `src/ir/io.ts`; `storageStateHasContent`, `StorageState` from `src/replayer/retarget.ts`; `transitiveRequires`, `LoadedStep` from `src/steps.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/sessions-plan.test.ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/sessions-plan.test.ts`
Expected: FAIL, `Cannot find module '../src/sessions.js'`.

- [ ] **Step 3: Create the sessions module (pure half)**

```ts
// src/sessions.ts
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { captureStorageState } from './browser.js';
import { REPROS_DIR, writeFileAtomic } from './ir/io.js';
import type { Repro } from './ir/schema.js';
import { storageStateHasContent, type StorageState } from './replayer/retarget.js';
import { runStep, transitiveRequires, type LoadedStep } from './steps.js';

/**
 * Project sessions.
 *
 * A session belongs to the project and the account, not to the repro. A step
 * marked `establishesSession` produces one, every repro that walks through the
 * step shares it, and it is re-established only when it dies. Ten issues cost
 * one sign-in plus one more per expiry, instead of one per recording.
 *
 * Nothing here probes a session without proof. A probe on a start path where
 * the step's `ensures` is never visible would wait the full timeout and then
 * sign in, on every run, which is the failure this module exists to remove.
 * Proof is recorded per start path in the meta sidecar, and replay only
 * probes a repro that carries `sessionCheck`.
 */

export const SESSIONS_DIR = path.join(REPROS_DIR, 'sessions');

/** Step name, plus a short hash of the explicit params so two accounts never share a file. */
export function sessionKey(step: string, params: Record<string, string> = {}): string {
  const entries = Object.entries(params).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return step;
  const hash = createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 6);
  return `${step}.${hash}`;
}

/** `host:port` is not a legal file name on Windows, so the colon is written as an underscore. */
export function hostSlug(url: string): string {
  return new URL(url).host.replace(/:/g, '_');
}

export interface SessionFiles {
  /** A raw Playwright storage state, usable with --storage-state by hand. */
  state: string;
  /** The sidecar with what the tool learned about it. Null for a per-repro state file. */
  meta: string | null;
}

export function sessionFiles(root: string, key: string, host: string): SessionFiles {
  const base = path.join(root, SESSIONS_DIR, `${key}@${host}`);
  return { state: `${base}.json`, meta: `${base}.meta.json` };
}

/** Inverse of `sessionFiles` for any path; null for a path that is not a project session file. */
export function parseSessionPath(statePath: string): { key: string; host: string } | null {
  const name = path.basename(statePath);
  if (path.basename(path.dirname(statePath)) !== 'sessions') return null;
  if (!name.endsWith('.json') || name.endsWith('.meta.json')) return null;
  const at = name.lastIndexOf('@');
  if (at < 1) return null;
  return { key: name.slice(0, at), host: name.slice(at + 1, -'.json'.length) };
}

export interface SessionMeta {
  mintedAt: string;
  /** Start paths on which the step's `ensures` was seen right after a real sign-in. */
  provenPaths: string[];
}

const EMPTY_META: SessionMeta = { mintedAt: '', provenPaths: [] };

export function readMeta(file: string | null): SessionMeta {
  if (!file || !existsSync(file)) return { ...EMPTY_META, provenPaths: [] };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<SessionMeta>;
    return {
      mintedAt: typeof raw.mintedAt === 'string' ? raw.mintedAt : '',
      provenPaths: Array.isArray(raw.provenPaths) ? raw.provenPaths.filter((p) => typeof p === 'string') : [],
    };
  } catch {
    return { ...EMPTY_META, provenPaths: [] };
  }
}

/** The stored state, or null when the file is missing, corrupt, or holds no session. */
export function readSessionState(file: string): StorageState | null {
  if (!existsSync(file)) return null;
  try {
    const state = JSON.parse(readFileSync(file, 'utf8')) as StorageState;
    return storageStateHasContent(state) ? state : null;
  } catch {
    return null;
  }
}

/**
 * Write the captured state and update the proof for one start path.
 *
 * A path that stopped proving is removed, so the next recording on it signs in
 * for real instead of probing a selector that is no longer there.
 */
export async function persistSession(
  files: SessionFiles,
  state: string,
  proof: { path: string; proven: boolean },
): Promise<void> {
  await writeFileAtomic(files.state, state);
  if (!files.meta) return;
  const current = readMeta(files.meta);
  const provenPaths = proof.proven
    ? current.provenPaths.includes(proof.path)
      ? current.provenPaths
      : [...current.provenPaths, proof.path]
    : current.provenPaths.filter((p) => p !== proof.path);
  const meta: SessionMeta = { mintedAt: new Date().toISOString(), provenPaths };
  await writeFileAtomic(files.meta, `${JSON.stringify(meta, null, 2)}\n`);
}

export interface SessionTarget {
  step: LoadedStep;
  params: Record<string, string>;
  key: string;
  host: string;
  files: SessionFiles;
}

export interface SessionPlan {
  /** Null when this recording does not share a session. */
  target: SessionTarget | null;
  /** Seed the context from this file before the browser opens. */
  seedPath: string | null;
  /** The start path is proven for this session, so a seeded context may be probed. */
  probe: boolean;
  /** Why sharing is off, for the record output. Null when it is on. */
  disabled: string | null;
}

function sessionStepsIn(
  setup: { step: string }[],
  steps: Map<string, LoadedStep>,
): LoadedStep[] {
  return Array.from(transitiveRequires(setup.map((s) => s.step), steps))
    .map((name) => steps.get(name))
    .filter((s): s is LoadedStep => Boolean(s?.establishesSession));
}

/**
 * Decide, before the browser opens, whether a recording seeds a stored session.
 *
 * Playwright can only seed a session when the context is created, so this has
 * to run from the declared setup rather than from whatever `drive` ends up
 * calling. An unproven start path is never probed: signing in for real costs
 * one sign-in, a failed probe costs the full timeout and then the sign-in.
 */
export function planSession(o: {
  root: string;
  baseUrl: string;
  startPath: string;
  setup: { step: string; params?: Record<string, string> }[];
  steps: Map<string, LoadedStep>;
  explicitSeed: 'storage-state' | 'profile' | null;
}): SessionPlan {
  const none = { target: null, seedPath: null, probe: false };
  const sessionSteps = sessionStepsIn(o.setup, o.steps);
  if (!sessionSteps.length) return { ...none, disabled: null };
  if (o.explicitSeed) {
    return { ...none, disabled: `--${o.explicitSeed} was given, so the declared session step is not shared` };
  }
  if (sessionSteps.length > 1) {
    return {
      ...none,
      disabled:
        `two session steps in one setup (${sessionSteps.map((s) => s.name).join(', ')}); ` +
        'a single seeded state cannot represent two accounts',
    };
  }
  const step = sessionSteps[0]!;
  if (!step.ensures) {
    return { ...none, disabled: `step "${step.name}" has no ensures, so a stored session cannot be checked` };
  }
  const params = o.setup.find((s) => s.step === step.name)?.params ?? {};
  const key = sessionKey(step.name, params);
  const host = hostSlug(o.baseUrl);
  const files = sessionFiles(o.root, key, host);
  const stored = readSessionState(files.state) !== null;
  const probe = stored && readMeta(files.meta).provenPaths.includes(o.startPath);
  return { target: { step, params, key, host, files }, seedPath: probe ? files.state : null, probe, disabled: null };
}
```

Leave `captureStorageState`, `runStep`, `BrowserContext`, `Page` and `Repro` imported; Task 6 and Task 7 add the functions that use them. If the linter or `tsc` complains about unused imports at this point, add the imports in Task 6 instead.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/sessions-plan.test.ts && npm run typecheck`
Expected: PASS, 10 tests, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/sessions.ts tests/sessions-plan.test.ts
git commit -m "Name project sessions on disk and decide how a recording seeds one

A session file is keyed by step, explicit params and host. Its sidecar records
the start paths on which the step's ensures was proven visible, and the plan
made before the browser opens seeds and probes only on such a path.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BgVy4HW385PjgtJLmbc6E8"
```

---

### Task 6: Record with a declared session

**Files:**
- Modify: `src/sessions.ts` (append `ensuresVisible`, `establishSession`, `SessionStatus`, `SessionOutcome`)
- Modify: `src/recorder/launch.ts` (options, result, declared setup, shared session on `api.step`)
- Modify: `src/api.ts:19-115` (`RecordOptions`, `RecordResult`, `record`)
- Test: `tests/sessions.test.ts` (new; the replay half is added in Task 7)

**Interfaces:**
- Produces:
  - `SessionStatus = 'reused' | 'established' | 're-established'`
  - `SessionOutcome = { step: string; key: string; host: string; status: SessionStatus; proven: boolean; statePath: string }`
  - `ensuresVisible(page: Page, step: LoadedStep): Promise<boolean>`
  - `establishSession(o: { page; context; steps; ran: Set<string>; target: SessionTarget; startUrl: string; startPath: string; probe: boolean; persist: boolean }): Promise<{ status: SessionStatus; proven: boolean }>`
  - `LaunchRecordingOptions.setup?`, `.session?: SessionPlan | null`, `.root?`, `.browser?: Browser | null`
  - `RecordingResult.session: SessionOutcome | null`, `.warnings: string[]`
  - `RecordOptions.setup?`, `.browser?`; `RecordResult.session`, `.warnings`
- Consumes: `planSession`, `persistSession`, `sessionKey`, `hostSlug`, `sessionFiles` from Task 5; `sessionCheck` compile option from Task 3.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/sessions.test.ts
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
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/sessions.test.ts`
Expected: FAIL, `setup` is not a known option and `session` is undefined on the result.

- [ ] **Step 3: Append the browser half to `src/sessions.ts`**

```ts
export type SessionStatus = 'reused' | 'established' | 're-established';

/** What a recording ends up sharing, for the IR and for whoever is reading the output. */
export interface SessionOutcome {
  step: string;
  key: string;
  host: string;
  status: SessionStatus;
  /** The step's ensures was visible on the start path, so the repro may carry sessionCheck. */
  proven: boolean;
  /** Absolute path of the shared state file the repro should point at. */
  statePath: string;
}

/** Whether the step's `ensures` is visible on the current page, within the step's own budget. */
export async function ensuresVisible(page: Page, step: LoadedStep): Promise<boolean> {
  if (!step.ensures) return false;
  try {
    await page
      .locator(step.ensures)
      .first()
      .waitFor({ state: 'visible', timeout: step.ensuresTimeoutMs ?? 30_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Trust a seeded session if it proves alive, otherwise sign in for real, and
 * record whether the start path proves.
 *
 * One routine for record and replay, so the probe and the heal cannot
 * diverge. `probe` is only ever true when the caller holds proof for this
 * start path; a probe without proof would time out and sign in every time.
 */
export async function establishSession(o: {
  page: Page;
  context: BrowserContext;
  steps: Map<string, LoadedStep>;
  ran: Set<string>;
  target: SessionTarget;
  startUrl: string;
  startPath: string;
  probe: boolean;
  /** Write the state and proof back. Off under a persistent profile, which holds its own session. */
  persist: boolean;
}): Promise<{ status: SessionStatus; proven: boolean }> {
  const { step } = o.target;
  if (o.probe && (await ensuresVisible(o.page, step))) {
    o.ran.add(step.name);
    return { status: 'reused', proven: true };
  }
  // Replay marks a restored session's steps as run before getting here, and
  // runStep returns early for anything in that set.
  o.ran.delete(step.name);
  await runStep(step.name, o.page, o.steps, o.ran, o.target.params);
  const state = await captureStorageState(o.context);
  await o.page.goto(o.startUrl, { waitUntil: 'domcontentloaded' });
  const proven = await ensuresVisible(o.page, step);
  if (o.persist) await persistSession(o.target.files, state, { path: o.startPath, proven });
  return { status: o.probe ? 're-established' : 'established', proven };
}
```

- [ ] **Step 4: Teach the recorder about declared setup and the plan**

In `src/recorder/launch.ts`:

Imports: add `import type { Browser, Page } from 'playwright';` (replacing the `Page` type import) and

```ts
import {
  ensuresVisible,
  establishSession,
  hostSlug,
  persistSession,
  sessionFiles,
  sessionKey,
  type SessionOutcome,
  type SessionPlan,
} from '../sessions.js';
```

Add to `LaunchRecordingOptions`:

```ts
  /**
   * Setup declared up front and run before `drive` gets the page.
   *
   * Declared rather than invoked so a session step can be seeded from the
   * project's stored session before the context exists, the only point at
   * which Playwright can seed one.
   */
  setup?: { step: string; params?: Record<string, string> }[];
  /** How the declared session step is seeded, decided by `planSession` before the browser opens. */
  session?: SessionPlan | null;
  /** Project root, where session files live. */
  root?: string;
  /** Record inside an already-running browser, e.g. the MCP server's pool. */
  browser?: Browser | null;
```

Add to `RecordingResult`:

```ts
  /** The shared session this recording reused or wrote; null when the repro keeps its own state. */
  session: SessionOutcome | null;
  /** Non-fatal things the caller should show: sharing disabled and why, a start path that did not prove. */
  warnings: string[];
```

In `launchRecording`, change the `openBrowser` call:

```ts
  const plan = options.session ?? null;
  const opened = await openBrowser({
    headless: options.headless ?? false,
    viewport,
    storageStatePath: plan?.seedPath ?? options.storageStatePath ?? null,
    profileDir: options.profileDir ?? null,
    browser: options.browser ?? null,
  });
```

Replace everything from `const observed: { selector: string; absent: boolean }[] = [];` down to the end of the `const api: DriveApi = { ... };` block with:

```ts
    const observed: { selector: string; absent: boolean }[] = [];
    const setup: { step: string; params?: Record<string, string> }[] = [];
    const ranSteps = new Set<string>();
    const steps = options.steps ?? new Map<string, LoadedStep>();
    const root = options.root ?? process.cwd();
    const warnings: string[] = [];
    let sessionOutcome: SessionOutcome | null = null;
    // Overwritten each time a session-establishing step completes, so the final
    // value is the session as it stood once all sign-in was done.
    let sessionStorageState: string | null = null;

    const invoke = async (name: string, params?: Record<string, string>): Promise<void> => {
      // Nothing setup does belongs in the IR. Recorded, it is copied into
      // every repro that used it, and fixing the shared function would fix
      // none of them.
      session.suspend();
      try {
        await runStep(name, page, steps, ranSteps, params ?? {});
      } finally {
        session.resume();
      }
      setup.push({ step: name, ...(params ? { params } : {}) });
      // Sign-in may sit behind the invoked step as a `requires` dependency
      // rather than being invoked itself, so the whole chain decides whether
      // this call established a session.
      const sessionSteps = Array.from(transitiveRequires([name], steps))
        .map((n) => steps.get(n))
        .filter((s): s is LoadedStep => Boolean(s?.establishesSession));
      if (!sessionSteps.length) return;
      const state = await captureStorageState(context);
      sessionStorageState = state;

      // A session step invoked from drive() rather than declared still leaves
      // a shared session behind, under the same eligibility rules as a
      // declared one, so the next recording can declare it and skip the
      // sign-in this one paid. Only when the declared setup had no session
      // step at all: a plan that shared or refused already decided. Proof is
      // claimed only if the page happens to be on the start path right now;
      // navigating away would disrupt the driver mid-flow.
      const only = sessionSteps[0];
      if (
        plan?.target ||
        plan?.disabled ||
        sessionOutcome ||
        sessionSteps.length > 1 ||
        !only?.ensures ||
        options.storageStatePath ||
        options.profileDir
      ) {
        return;
      }
      const key = sessionKey(only.name, name === only.name ? (params ?? {}) : {});
      const host = hostSlug(options.baseUrl);
      const files = sessionFiles(root, key, host);
      const onStartPath = pathOf(page.url(), options.baseUrl) === startPath;
      const proven = onStartPath && (await ensuresVisible(page, only));
      await persistSession(files, state, { path: startPath, proven });
      sessionOutcome = { step: only.name, key, host, status: 'established', proven, statePath: files.state };
    };

    const api: DriveApi = {
      step: invoke,
      async observe(selector, opts) {
        const absent = Boolean(opts?.absent);
        const count = await page.locator(selector).count();
        const holds = absent ? count === 0 : count > 0;
        if (!holds) {
          throw new Error(
            `observe(${JSON.stringify(selector)}${absent ? ', { absent: true }' : ''}) does not hold right now. ` +
              `Recording an assertion that is already false would produce a verdict about something other than the bug.`,
          );
        }
        observed.push({ selector, absent });
      },
    };

    // Declared setup runs before the driver gets the page. The session step is
    // handled first so the rest of the declared steps find it already done.
    if (plan?.disabled) warnings.push(`declared setup is not shared: ${plan.disabled}`);
    if (plan?.target) {
      session.suspend();
      try {
        const result = await establishSession({
          page,
          context,
          steps,
          ran: ranSteps,
          target: plan.target,
          startUrl,
          startPath,
          probe: plan.probe,
          persist: true,
        });
        sessionOutcome = {
          step: plan.target.step.name,
          key: plan.target.key,
          host: plan.target.host,
          status: result.status,
          proven: result.proven,
          statePath: plan.target.files.state,
        };
        if (!result.proven) {
          warnings.push(
            `step "${plan.target.step.name}" signed in, but its ensures (${plan.target.step.ensures}) is not visible on ${startPath}; ` +
              'this repro will restore the session without checking it',
          );
        }
      } finally {
        session.resume();
      }
    }
    for (const entry of options.setup ?? []) await invoke(entry.step, entry.params);
```

In the final `return`, add `session: sessionOutcome, warnings,` after `setup,`.

- [ ] **Step 5: Wire `record()` in `src/api.ts`**

Imports: add `import type { Browser, Page } from 'playwright';` (extend the existing `Page` type import) and `import { planSession, type SessionOutcome } from './sessions.js';`.

Add to `RecordOptions`:

```ts
  /**
   * Shared setup declared up front and run before `drive` gets the page.
   *
   * Declared rather than invoked so a session step is seeded from the project's
   * stored session before the context exists. `api.step()` inside `drive`
   * still works for everything else.
   */
  setup?: { step: string; params?: Record<string, string> }[];
  /** Record inside an already-running browser, e.g. the MCP server's pool. */
  browser?: Browser | null;
```

Replace `RecordResult`:

```ts
export interface RecordResult {
  repro: Repro;
  irPath: string;
  stopReason: string;
  /** The shared session reused or written; null when the repro keeps its own state file. */
  session: SessionOutcome | null;
  /** Non-fatal things worth printing: sharing disabled and why, a start path that did not prove. */
  warnings: string[];
}
```

Replace the body of `record()` from `const { trace, ... } = await launchRecording({` to the end of the function:

```ts
  const declared = options.setup ?? [];
  const plan = planSession({
    root,
    baseUrl: options.baseUrl,
    startPath: options.startPath ?? '/',
    setup: declared,
    steps: sharedSteps,
    explicitSeed: options.storageStatePath ? 'storage-state' : options.profileDir ? 'profile' : null,
  });

  const { trace, storageState, stopReason, driveError, observed, setup, session, warnings } =
    await launchRecording({
      baseUrl: options.baseUrl,
      startPath: options.startPath,
      viewport: options.viewport,
      storageStatePath: options.storageStatePath ?? null,
      profileDir: options.profileDir ?? null,
      onReady: options.onReady,
      headless: options.headless,
      drive: options.drive,
      steps: sharedSteps,
      setup: declared,
      session: plan,
      root,
      browser: options.browser ?? null,
    });

  // A shared session is referenced, not copied: one file to refresh when it
  // expires, and no per-repro snapshot to go stale beside it.
  let storageStatePath: string;
  if (session) {
    storageStatePath = path.relative(root, session.statePath);
  } else {
    await writeFileAtomic(paths.storageState, storageState);
    storageStatePath = path.relative(root, paths.storageState);
  }

  const repro = compile(trace, {
    name: options.name,
    storageStatePath,
    observed,
    setup,
    ...(session?.proven ? { sessionCheck: { step: session.step } } : {}),
  });

  // Written before any error is raised: a driver that failed on step 12 still
  // captured eleven real steps, and throwing them away wastes the whole run.
  await writeRepro(repro, paths);

  if (driveError) throw new PartialRecordingError(driveError, paths.ir, repro);
  return { repro, irPath: paths.ir, stopReason, session, warnings };
```

- [ ] **Step 6: Run the new tests, the steps suite and the type check**

Run: `npx vitest run tests/sessions.test.ts tests/steps.test.ts && npm run typecheck`
Expected: sessions PASS (8 tests). In `tests/steps.test.ts` two tests now fail because the `session` fixture is invoked from `drive()` and the repro points at the shared file rather than `.repros/<name>/state.json`. Fix them in the next step.

- [ ] **Step 7: Point the two steps tests at the repro's own `storageStatePath`**

In `tests/steps.test.ts`, test `skips a session step reached through requires`: replace the `state` read with

```ts
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
```

Test `does not let an empty state file masquerade as a session`: replace the `statePath` line with

```ts
    const statePath = path.join(root, '.repros/sessions/session@localhost_5441.json');
```

Run: `npx vitest run tests/steps.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/sessions.ts src/recorder/launch.ts src/api.ts tests/sessions.test.ts tests/steps.test.ts
git commit -m "Share one session across every recording that declares the same step

Every recording re-ran its sign-in step, so ten issues meant ten sign-ins.
A recording now declares its setup, the session step is seeded from the
project's stored session on a start path proven before, and signs in for
real otherwise. The repro points at the shared file and carries sessionCheck
only when the start path proved.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BgVy4HW385PjgtJLmbc6E8"
```

---

### Task 7: Replay probes a proven session and heals it once

**Files:**
- Modify: `src/sessions.ts` (append `replaySessionTarget`)
- Modify: `src/replayer/run.ts:186-230` (seed, `haveSession`, probe block), `src/replayer/run.ts:616-635` (`resolveSessionSeed`)
- Test: `tests/sessions.test.ts` (append a describe)

**Interfaces:**
- Produces: `replaySessionTarget(o: { repro: Repro; root: string; baseUrl: string; steps: Map<string, LoadedStep> }): SessionTarget | null`. `RunResult.notes` carries `session re-established via step "<name>" (stored session had expired)` after a heal. `resolveSessionSeed` prefers `.repros/sessions/<key>@<envHost>.json` under `envUrl`.
- Consumes: `establishSession`, `parseSessionPath`, `sessionFiles`, `hostSlug`, `readSessionState`, `sessionKey` from Tasks 5 and 6.

- [ ] **Step 1: Write the failing tests**

Append to `tests/sessions.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/sessions.test.ts -t "replay trusts"`
Expected: FAIL. `re-establishes an expired session` fails because the stale session is restored and skipped without a probe.

- [ ] **Step 3: Append `replaySessionTarget` to `src/sessions.ts`**

```ts
/**
 * What replay verifies, for a repro carrying `sessionCheck`.
 *
 * The key comes from the file the repro points at, so a hand-edited or
 * retargeted path still resolves. The host is the one replay is driving, so a
 * heal under --env writes the target host's file and leaves the recorded
 * host's alone. A per-repro state file keeps its own path and has no sidecar.
 */
export function replaySessionTarget(o: {
  repro: Repro;
  root: string;
  baseUrl: string;
  steps: Map<string, LoadedStep>;
}): SessionTarget | null {
  const check = o.repro.sessionCheck;
  if (!check || !o.repro.storageStatePath) return null;
  const step = o.steps.get(check.step);
  if (!step?.ensures) return null;
  const params = o.repro.setup.find((s) => s.step === step.name)?.params ?? {};
  const host = hostSlug(o.baseUrl);
  const parsed = parseSessionPath(o.repro.storageStatePath);
  const key = parsed?.key ?? sessionKey(step.name, params);
  const files: SessionFiles = parsed
    ? sessionFiles(o.root, key, host)
    : { state: path.resolve(o.root, o.repro.storageStatePath), meta: null };
  return { step, params, key, host, files };
}
```

- [ ] **Step 4: Probe and heal in `runRepro`, and prefer the target host's file**

In `src/replayer/run.ts`, add the import:

```ts
import {
  establishSession,
  hostSlug,
  parseSessionPath,
  readSessionState,
  replaySessionTarget,
  sessionFiles,
} from '../sessions.js';
```

Replace the `page.goto(...)` line and the `haveSession` line so the start URL is reused and a seeded env-host file counts as a session:

```ts
    const startUrl = new URL(repro.startPath, baseUrl).toString();
    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
```

```ts
      const haveSession = Boolean(seed.storageStatePath || seed.storageState || options.profileDir);
```

Insert between the `if (haveSession) { ... }` block that fills `ran` and the `for (const entry of repro.setup)` loop:

```ts
      // A restored session is trusted blindly unless record time proved this
      // step's ensures visible on this start path. Probing without that proof
      // would time out and sign in on every replay.
      const target = haveSession && repro.sessionCheck
        ? replaySessionTarget({ repro, root, baseUrl, steps })
        : null;
      if (target) {
        try {
          const outcome = await establishSession({
            page,
            context,
            steps,
            ran,
            target,
            startUrl,
            startPath: repro.startPath,
            probe: true,
            persist: !options.profileDir,
          });
          if (outcome.status === 're-established') {
            if (!outcome.proven) {
              throw new StepError(
                target.step.name,
                `re-established the session, but its ensures (${target.step.ensures}) is still not visible on ${repro.startPath}.\n` +
                  `      Defined in: ${target.step.file}\n` +
                  `      Fix the step's ensures, or remove sessionCheck from the repro.`,
              );
            }
            notes.push(`session re-established via step "${target.step.name}" (stored session had expired)`);
          }
        } catch (err) {
          // Setup that could not run says nothing about the bug.
          return await fail(
            { paths, page, repro, reactions, timings: [], startedAt, since: startedAt, expectFixed, notes, baseUrl },
            {
              stepId: 'setup',
              stepIndex: 0,
              semantic: `session step "${target.step.name}"`,
              kind: 'infrastructure',
              expected: 'the stored session to be valid, or the step to re-establish it',
              observed: err instanceof StepError ? err.message : (err as Error).message,
            },
          );
        }
      }
```

Replace `resolveSessionSeed`:

```ts
export function resolveSessionSeed(
  repro: Repro,
  root: string,
  options: { envUrl?: string | null; profileDir?: string | null },
): { storageStatePath: string | null; storageState: Record<string, unknown> | null } {
  if (options.profileDir) return { storageStatePath: null, storageState: null };
  // A session minted against the target host is exact. Only when there is
  // none does the recorded host's session get retargeted in memory.
  if (options.envUrl && repro.storageStatePath) {
    const parsed = parseSessionPath(repro.storageStatePath);
    if (parsed) {
      const own = sessionFiles(root, parsed.key, hostSlug(options.envUrl)).state;
      if (readSessionState(own)) return { storageStatePath: own, storageState: null };
    }
  }
  const sessionPath = storageStatePath(repro, root);
  if (!sessionPath) return { storageStatePath: null, storageState: null };
  if (!options.envUrl) return { storageStatePath: sessionPath, storageState: null };
  // A session is origin-keyed, so restoring it unchanged would authenticate
  // the environment it was recorded against and leave the target signed out.
  return {
    storageStatePath: null,
    storageState: retargetStorageState(
      JSON.parse(readFileSync(sessionPath, 'utf8')) as StorageState,
      repro.baseUrl,
      options.envUrl,
    ) as Record<string, unknown>,
  };
}
```

`context` must be in scope at the probe: the surrounding code destructures `const { context, page } = opened;` already.

- [ ] **Step 5: Run the session, steps and MCP suites and the type check**

Run: `npx vitest run tests/sessions.test.ts tests/steps.test.ts tests/mcp.test.ts && npm run typecheck`
Expected: PASS. The MCP suite proves warm sessions, which go through `openSession` and `resolveSessionSeed`, still work.

- [ ] **Step 6: Commit**

```bash
git add src/sessions.ts src/replayer/run.ts tests/sessions.test.ts
git commit -m "Verify a restored session on replay and re-establish it once when it has expired

A dead token used to surface as an unrelated step failure. Replay now checks
the sign-in step's ensures on the start path, but only for a repro whose
record time proved that check, re-runs the step once, rewrites the shared
session and says so in the notes. Under --env the target host gets its own
session file, so the second replay there starts warm.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BgVy4HW385PjgtJLmbc6E8"
```

---

### Task 8: Drive files, for the CLI

**Files:**
- Create: `src/drive.ts`
- Modify: `src/sessions.ts` (append `describeSession`)
- Modify: `src/ir/io.ts:8-19` (`ReproPaths`), `src/ir/io.ts:36-51` (`reproPaths`), `src/ir/io.ts:170-179` (`deleteRepro`)
- Modify: `src/cli/index.ts:35-88` (`record` command)
- Modify: `src/api.ts` exports
- Test: `tests/drive.test.ts`

**Interfaces:**
- Produces:
  - `DriveDefinition = { setup?: { step: string; params?: Record<string,string> }[]; drive(page: Page, api: DriveApi): Promise<void> }`
  - `defineDrive(d: DriveDefinition): DriveDefinition`
  - `loadDrive(file: string): Promise<DriveDefinition>`, throws naming the file
  - `describeSession(outcome: SessionOutcome): string`
  - `ReproPaths.drive` (`.repros/drive/<name>.mjs`); `deleteRepro` removes it
  - CLI: `repro record <name> --url <base> --drive <file> [--headed]`
- Consumes: `importFresh` (Task 2), `record({ setup, drive })` (Task 6).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/drive.test.ts
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteRepro, record, reproPaths } from '../src/api.js';
import { loadDrive } from '../src/drive.js';
import { startDemoServer, type DemoServer } from './helpers/demo-server.js';

/**
 * A drive file is how an agent hands the tool a recording: a module exporting
 * defineDrive({ setup, drive }). It produces the same IR a programmatic
 * record() does, because it is one.
 */

let server: DemoServer;
let root: string;

const DRIVE_BODY = `export default {
  async drive(page, { observe }) {
    await page.waitForSelector('[data-testid="sensor-row-1"]');
    await page.click('[data-testid="nav-reports"]');
    await page.waitForSelector('[data-testid="report-title-input"]');
    await observe('[data-testid="report-title-input"]');
  },
};`;

beforeAll(async () => {
  server = await startDemoServer(5447);
  root = await mkdtemp(path.join(tmpdir(), 'replay-drive-'));
  await mkdir(path.join(root, '.repros', 'drive'), { recursive: true });
}, 60_000);

afterAll(async () => {
  await server?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('loadDrive', () => {
  it('loads a default export with a drive function and passes setup through', async () => {
    const file = path.join(root, '.repros/drive/ok.mjs');
    await writeFile(file, `export default { setup: [{ step: 'signed-in' }], async drive() {} };`, 'utf8');
    const def = await loadDrive(file);
    expect(typeof def.drive).toBe('function');
    expect(def.setup).toEqual([{ step: 'signed-in' }]);
  });

  it('refuses a module without a drive function, naming the file', async () => {
    const file = path.join(root, '.repros/drive/bad.mjs');
    await writeFile(file, `export default { setup: [] };`, 'utf8');
    await expect(loadDrive(file)).rejects.toThrow(/bad\.mjs: no default export from defineDrive\(\)/);
  });

  it('names the file when it cannot be imported at all', async () => {
    await expect(loadDrive(path.join(root, '.repros/drive/missing.mjs'))).rejects.toThrow(/missing\.mjs/);
  });
});

describe('recording from a drive file', () => {
  it('produces the same IR as the same flow written in code', async () => {
    const file = path.join(root, '.repros/drive/from-file.mjs');
    await writeFile(file, DRIVE_BODY, 'utf8');
    const def = await loadDrive(file);

    await server.reset();
    const fromFile = await record({
      name: 'from-file',
      baseUrl: server.baseUrl,
      root,
      headless: true,
      setup: def.setup,
      drive: def.drive,
    });
    await server.reset();
    const fromCode = await record({
      name: 'from-code',
      baseUrl: server.baseUrl,
      root,
      headless: true,
      drive: async (page, { observe }) => {
        await page.waitForSelector('[data-testid="sensor-row-1"]');
        await page.click('[data-testid="nav-reports"]');
        await page.waitForSelector('[data-testid="report-title-input"]');
        await observe('[data-testid="report-title-input"]');
      },
    });

    const shape = (steps: { action: string; value: string | null; target?: { candidates: string[] } }[]) =>
      steps.map((s) => [s.action, s.target?.candidates[0] ?? null, s.value]);
    expect(shape(fromFile.repro.steps)).toEqual(shape(fromCode.repro.steps));
    expect(fromFile.repro.steps.length).toBeGreaterThan(0);
    expect(fromFile.repro.assertion.finalState).toEqual(fromCode.repro.assertion.finalState);
  });

  it('is deleted with its repro', async () => {
    const paths = reproPaths('from-file', root);
    expect(paths.drive).toBe(path.join(root, '.repros/drive/from-file.mjs'));
    expect(existsSync(paths.drive)).toBe(true);
    expect(await deleteRepro('from-file', root)).toBe(true);
    expect(existsSync(paths.ir)).toBe(false);
    expect(existsSync(paths.drive)).toBe(false);
    // A repro without a drive file deletes cleanly too.
    expect(await deleteRepro('from-code', root)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/drive.test.ts`
Expected: FAIL, `Cannot find module '../src/drive.js'`.

- [ ] **Step 3: Create the drive module**

```ts
// src/drive.ts
import type { Page } from 'playwright';
import { importFresh } from './import-fresh.js';
import type { DriveApi } from './recorder/launch.js';

/**
 * A recording an agent hands to the tool as a file.
 *
 * The agent already has the locators from exploring the bug; a drive file is
 * where they go. `setup` is declared rather than invoked so the session step
 * can be seeded from the project's stored session before the browser opens.
 */
export interface DriveDefinition {
  /** Shared setup run before `drive`, by name. A session step here is seeded, not re-run. */
  setup?: { step: string; params?: Record<string, string> }[];
  drive(page: Page, api: DriveApi): Promise<void>;
}

/** Identity function that exists to give the definition a type. */
export function defineDrive(definition: DriveDefinition): DriveDefinition {
  return definition;
}

/** Import a drive file, seeing edits made since the last import, and check its shape. */
export async function loadDrive(file: string): Promise<DriveDefinition> {
  let mod: { default?: unknown };
  try {
    mod = await importFresh<{ default?: unknown }>(file);
  } catch (err) {
    throw new Error(`Could not load drive file ${file}: ${(err as Error).message.split('\n')[0]}`);
  }
  const def = mod.default as Partial<DriveDefinition> | undefined;
  if (typeof def?.drive !== 'function') {
    throw new Error(`${file}: no default export from defineDrive()`);
  }
  return def as DriveDefinition;
}
```

- [ ] **Step 4: Add the drive path to the layout and delete it with the repro**

In `src/ir/io.ts`, add to `ReproPaths`:

```ts
  /** The agent-written recording script, if there was one: .repros/drive/<name>.mjs */
  drive: string;
```

In `reproPaths`, add to the returned object:

```ts
    drive: path.join(reprosDir, 'drive', `${name}.mjs`),
```

In `deleteRepro`, after `await rm(paths.dir, ...)`:

```ts
  // The drive file is the recipe for this one repro and goes with it.
  await rm(paths.drive, { force: true });
```

- [ ] **Step 5: Add `describeSession` to `src/sessions.ts` and export the new pieces from `src/api.ts`**

Append to `src/sessions.ts`:

```ts
/** One line for the record output, shared by the CLI and the MCP server. */
export function describeSession(outcome: SessionOutcome | null): string {
  if (!outcome) return 'none (no session step declared)';
  const where = `step "${outcome.step}"`;
  switch (outcome.status) {
    case 'reused':
      return `reused the stored session for ${where}, no sign-in`;
    case 'established':
      return `signed in via ${where} and stored the session for later recordings`;
    case 're-established':
      return `stored session for ${where} had expired; signed in again and replaced it`;
  }
}
```

In `src/api.ts`, add:

```ts
export { defineDrive, loadDrive, type DriveDefinition } from './drive.js';
export { describeSession, type SessionOutcome, type SessionStatus } from './sessions.js';
```

- [ ] **Step 6: Wire `--drive` and `--headed` into `repro record`**

In `src/cli/index.ts`, add `loadDrive` and `describeSession` to the `../api.js` import. Replace the `record` command:

```ts
program
  .command('record')
  .argument('<name>', 'name for this repro')
  .requiredOption('-u, --url <baseUrl>', 'base URL of your dev server, e.g. http://localhost:3000')
  .option('-p, --path <startPath>', 'path to start recording at', '/')
  .option('--viewport <WxH>', 'browser viewport', '1440x900')
  .option('--storage-state <file>', 'seed cookies/localStorage/IndexedDB from a Playwright state file')
  .option('--profile <dir>', 'record against a persistent Chromium profile (reuses a login)')
  .option('--drive <file>', 'run a drive file (defineDrive) instead of waiting for a human; headless')
  .option('--headed', 'with --drive, watch the recording in a visible browser', false)
  .description('launch an instrumented browser and record a bug reproduction')
  .action(async (name: string, opts) => {
    const viewport = parseViewport(opts.viewport);
    const driven = opts.drive ? await loadDrive(path.resolve(opts.drive)) : null;

    const { repro, irPath, stopReason, session, warnings } = await record({
      name,
      baseUrl: opts.url,
      startPath: opts.path,
      viewport,
      storageStatePath: opts.storageState ?? null,
      profileDir: opts.profile ?? null,
      // A driven recording has nobody watching, so it runs headless unless asked.
      ...(driven ? { drive: driven.drive, setup: driven.setup, headless: !opts.headed } : {}),
      onReady: () => {
        console.log(`${green('●')} ${bold('Recording')} ${cyan(name)} on ${opts.url}${opts.path}`);
        console.log(
          driven
            ? dim(`  Driving from ${path.relative(process.cwd(), path.resolve(opts.drive))}.`)
            : dim(`  Reproduce the bug, then press ${STOP_HOTKEY} — or just close the browser.`),
        );
        console.log('');
      },
    });

    if (!repro.steps.length) {
      console.log(yellow('No actions captured — nothing was written.'));
      console.log(dim('  If you did interact, check that the app loaded before you started.'));
      process.exitCode = 1;
      return;
    }

    console.log(
      `${green('✓')} Captured ${bold(String(repro.steps.length))} steps ${dim(`(stopped: ${stopReason})`)}`,
    );
    console.log(`  ${dim('→')} ${path.relative(process.cwd(), irPath)}`);
    if (repro.setup.length) console.log(`  ${dim('session')} ${describeSession(session)}`);
    for (const warning of warnings) console.log(`  ${yellow('!')} ${warning}`);

    const { invariants, observedAtRecord } = repro.assertion;
    if (!invariants.noConsoleErrors || !invariants.noFailedRequests) {
      console.log('');
      console.log(yellow('  The bug was observed while recording:'));
      for (const e of observedAtRecord?.consoleErrors ?? []) {
        console.log(dim(`    console  ${truncate(e, 100)}`));
      }
      for (const f of observedAtRecord?.failedRequests ?? []) {
        console.log(dim(`    network  ${f.method} ${f.urlPattern} -> ${f.status ?? 'aborted'}`));
      }
      console.log(
        dim('    Those invariants are off so the repro passes its own replay; the evidence is'),
      );
      console.log(dim('    kept under assertion.observedAtRecord.'));
    }
  });
```

- [ ] **Step 7: Run the tests, the type check, and a CLI smoke run**

Run: `npx vitest run tests/drive.test.ts && npm run typecheck`
Expected: PASS, 5 tests, no type errors.

Smoke the CLI against the demo app, in a scratch directory so nothing lands in this repo's `.repros/`:

```bash
(npm run demo &) ; sleep 4
SCRATCH=$(mktemp -d) && mkdir -p "$SCRATCH/.repros/drive" && cat > "$SCRATCH/.repros/drive/smoke.mjs" <<'JS'
export default {
  async drive(page, { observe }) {
    await page.waitForSelector('[data-testid="sensor-row-1"]');
    await page.click('[data-testid="nav-reports"]');
    await page.waitForSelector('[data-testid="report-title-input"]');
    await observe('[data-testid="report-title-input"]');
  },
};
JS
(cd "$SCRATCH" && npx tsx /Users/mukhriddin/Desktop/fast-replay/src/cli/index.ts record smoke --url http://localhost:5173 --drive .repros/drive/smoke.mjs && npx tsx /Users/mukhriddin/Desktop/fast-replay/src/cli/index.ts run smoke)
```

Expected: `✓ Captured 1 steps (stopped: programmatic)` then `✓ BUG REPRODUCED smoke`. Stop the demo server afterwards (`kill %1` or find the Vite process on port 5173).

- [ ] **Step 8: Commit**

```bash
git add src/drive.ts src/sessions.ts src/ir/io.ts src/api.ts src/cli/index.ts tests/drive.test.ts
git commit -m "Record from a drive file

An agent that explored a bug had to hand-write a Node script importing the
API to turn it into a repro. repro record --drive runs a defineDrive module
headless and produces the same IR as a programmatic record(). The file lives
under .repros/drive/ and is deleted with its repro.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BgVy4HW385PjgtJLmbc6E8"
```

---

### Task 9: `repro_record` on the MCP server

**Files:**
- Modify: `src/mcp/server.ts` (imports, new tool after `repro_run`)
- Test: `tests/mcp.test.ts` (tool list, two new tests)

**Interfaces:**
- Produces: MCP tool `repro_record` with inputs `name`, `url`, `drive`, optional `start_path`, `headed`, `viewport` (`WxH`). Text starts `RECORDED <name> —` or `RECORDING STOPPED EARLY —`. `structuredContent`: `{ name, irPath, steps, stopReason, observed: { consoleErrors, failedRequests, evidence }, session: { status, step } | null, warnings, partial, error }`.
- Consumes: `record`, `loadDrive`, `describeSession`, `PartialRecordingError` from `src/api.ts`; `parseViewport` moved from the CLI to `src/api.ts`.

- [ ] **Step 1: Write the failing tests**

In `tests/mcp.test.ts`, add `'repro_record'` to the sorted tool list in `advertises the tools an agent needs`:

```ts
    expect(tools.map((t) => t.name).sort()).toEqual([
      'repro_artifacts',
      'repro_delete',
      'repro_extract',
      'repro_list',
      'repro_record',
      'repro_run',
      'repro_steps',
    ]);
```

Append inside `describe('mcp server', ...)`:

```ts
  it('records from a drive file in one call and reports what it saw', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const driveDir = path.join(root, '.repros', 'drive');
    await mkdir(driveDir, { recursive: true });
    await writeFile(
      path.join(driveDir, 'nav-only.mjs'),
      `export default {
        async drive(page, { observe }) {
          await page.waitForSelector('[data-testid="sensor-row-1"]');
          await page.click('[data-testid="nav-reports"]');
          await page.waitForSelector('[data-testid="report-title-input"]');
          await observe('[data-testid="report-title-input"]');
        },
      };`,
      'utf8',
    );
    await server.reset();
    const result = await call('repro_record', {
      name: 'nav-only',
      url: server.baseUrl,
      drive: '.repros/drive/nav-only.mjs',
    });
    expect(result.isError).toBeFalsy();
    const text = result.content.map((c) => c.text ?? '').join('\n');
    expect(text).toMatch(/^RECORDED nav-only — 1 step/);
    expect(text).toContain('.repros/nav-only.json');
    expect(text).toMatch(/Session: none/);
    expect(text).toContain('Evidence declared: [data-testid="report-title-input"]');
    // Nothing failed on the demo's happy path, so a fix has nothing to be checked against yet.
    expect(text).toMatch(/expect_fixed will refuse until/);
    expect(text).toMatch(/repro assert nav-only --fixed/);
    expect(result.structuredContent).toMatchObject({
      name: 'nav-only',
      steps: 1,
      partial: false,
      session: null,
      observed: { consoleErrors: [], failedRequests: [], evidence: ['[data-testid="report-title-input"]'] },
    });
  });

  it('runs the edited drive file on the next call, not the cached one', async () => {
    const { writeFile } = await import('node:fs/promises');
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(
      path.join(root, '.repros', 'drive', 'nav-only.mjs'),
      `export default {
        async drive(page, { observe }) {
          await page.waitForSelector('[data-testid="sensor-row-1"]');
          await page.click('[data-testid="nav-reports"]');
          await page.waitForSelector('[data-testid="report-title-input"]');
          // A second click, not a fill: the recorder commits a fill only on
          // change/blur or before the next action, so a recording that ends on
          // one would drop it and this test is about re-import, not capture.
          await page.click('[data-testid="nav-sensors"]');
          await page.waitForSelector('[data-testid="sensor-list"]');
          await observe('[data-testid="sensor-list"]');
        },
      };`,
      'utf8',
    );
    await server.reset();
    const result = await call('repro_record', {
      name: 'nav-and-back',
      url: server.baseUrl,
      drive: '.repros/drive/nav-only.mjs',
    });
    expect(result.structuredContent?.steps).toBe(2);
  });

  it('keeps the steps a failing driver captured and says the recording stopped early', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      path.join(root, '.repros', 'drive', 'breaks.mjs'),
      `export default {
        async drive(page) {
          await page.waitForSelector('[data-testid="sensor-row-1"]');
          await page.click('[data-testid="nav-reports"]');
          await page.waitForSelector('[data-testid="report-title-input"]');
          throw new Error('the dialog never opened');
        },
      };`,
      'utf8',
    );
    await server.reset();
    const result = await call('repro_record', {
      name: 'breaks',
      url: server.baseUrl,
      drive: '.repros/drive/breaks.mjs',
    });
    expect(result.isError).toBe(true);
    const text = result.content.map((c) => c.text ?? '').join('\n');
    expect(text).toMatch(/^RECORDING STOPPED EARLY — breaks, 1 step kept/);
    expect(text).toContain('the dialog never opened');
    expect(result.structuredContent).toMatchObject({ partial: true, steps: 1 });
  });

  it('refuses a drive file that is not one, naming it', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(root, '.repros', 'drive', 'not-a-drive.mjs'), `export default 42;`, 'utf8');
    const result = await call('repro_record', {
      name: 'nope',
      url: server.baseUrl,
      drive: '.repros/drive/not-a-drive.mjs',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/not-a-drive\.mjs: no default export from defineDrive\(\)/);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/mcp.test.ts`
Expected: FAIL, tool list lacks `repro_record`; the new calls return "tool not found".

- [ ] **Step 3: Move `parseViewport` to the API so both surfaces share it**

In `src/api.ts`, add:

```ts
/** `WxH` as typed on a command line or in a tool call. */
export function parseViewport(value: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/.exec(value.trim());
  if (!match) throw new Error(`Invalid viewport "${value}". Expected WxH, e.g. 1440x900.`);
  return { width: Number(match[1]), height: Number(match[2]) };
}
```

In `src/cli/index.ts`, delete the local `parseViewport` function and add `parseViewport` to the `../api.js` import.

- [ ] **Step 4: Register the tool**

In `src/mcp/server.ts`, extend the `../api.js` import with `describeSession, loadDrive, parseViewport, PartialRecordingError, record, type RecordResult`. Add after the `repro_run` registration:

```ts
  server.registerTool(
    'repro_record',
    {
      title: 'Record a bug repro from a drive file',
      description:
        'Record a repro by running a drive file: a module exporting defineDrive({ setup, drive }) where drive(page, { step, observe }) ' +
        'walks to the bug with Playwright and observe() names the evidence while it is on screen. ' +
        'Declare the sign-in step in setup so the stored project session is reused instead of signing in again. ' +
        'Write the file at .repros/drive/<name>.mjs, call this once, then verify fixes with repro_run. ' +
        'Returns the steps captured, the bug signature seen while recording, and whether a session was reused.',
      inputSchema: {
        name: z.string().describe('Name for the repro. Letters, digits, dot, dash, underscore.'),
        url: z.string().describe('Base URL of the running app, e.g. http://localhost:3000.'),
        drive: z.string().describe('Path to the drive file, relative to the project root or absolute.'),
        start_path: z.string().optional().describe('Path to start at. Default /.'),
        headed: z.boolean().optional().describe('Record in a visible browser. Default false.'),
        viewport: z.string().optional().describe('WxH, default 1440x900.'),
      },
    },
    async ({ name, url, drive, start_path, headed, viewport }) => {
      const refuse = (message: string) => ({
        content: [{ type: 'text' as const, text: message }],
        isError: true,
        structuredContent: { name, partial: false, error: message },
      });

      let driven: Awaited<ReturnType<typeof loadDrive>>;
      try {
        driven = await loadDrive(path.resolve(root, drive));
      } catch (err) {
        return refuse((err as Error).message);
      }

      const started = Date.now();
      let result: RecordResult | null = null;
      let partial: PartialRecordingError | null = null;
      try {
        result = await record({
          name,
          baseUrl: url,
          root,
          startPath: start_path ?? '/',
          viewport: parseViewport(viewport ?? '1440x900'),
          headless: !headed,
          drive: driven.drive,
          setup: driven.setup,
          browser: await pool.acquire(!headed),
        });
      } catch (err) {
        if (!(err instanceof PartialRecordingError)) return refuse((err as Error).message);
        partial = err;
      }

      const repro = result?.repro ?? partial!.repro;
      const irPath = path.relative(root, result?.irPath ?? partial!.irPath);
      const seconds = ((Date.now() - started) / 1000).toFixed(2);
      const observed = repro.assertion.observedAtRecord;
      const consoleErrors = observed?.consoleErrors ?? [];
      const failedRequests = observed?.failedRequests ?? [];
      const evidence = [
        ...(repro.assertion.finalState.domAppeared ?? []),
        ...(repro.assertion.finalState.domGone ?? []).map((s) => `${s} (absent)`),
      ];
      const stepWord = repro.steps.length === 1 ? 'step' : 'steps';

      const lines = partial
        ? [
            `RECORDING STOPPED EARLY — ${name}, ${repro.steps.length} ${stepWord} kept after ${seconds}s`,
            `Driver error: ${partial.cause.message}`,
            `IR: ${irPath}`,
            'The steps up to the failure are on disk. Fix the drive file and record again under this name, or repro_delete it.',
          ]
        : [
            `RECORDED ${name} — ${repro.steps.length} ${stepWord} in ${seconds}s (stopped: ${result!.stopReason})`,
            `IR: ${irPath}`,
            `Session: ${describeSession(result!.session)}`,
          ];
      for (const warning of result?.warnings ?? []) lines.push(`Note: ${warning}`);
      if (evidence.length) lines.push(`Evidence declared: ${evidence.join(', ')}`);
      if (consoleErrors.length || failedRequests.length) {
        lines.push('The bug, as observed while recording:');
        for (const e of consoleErrors) lines.push(`  console: ${e}`);
        for (const r of failedRequests) lines.push(`  network: ${r.method} ${r.urlPattern} -> ${r.status ?? 'aborted'}`);
      } else if (!partial) {
        lines.push(
          'No bug signature was observed (no console errors, no failed requests), so repro_run with ' +
            `expect_fixed will refuse until a criterion is named: repro assert ${name} --fixed --appeared <selector>.`,
        );
      }
      if (!partial) lines.push('Next: fix the code, then repro_run with expect_fixed=true after every change.');

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        isError: Boolean(partial),
        structuredContent: {
          name,
          irPath,
          steps: repro.steps.length,
          stopReason: result?.stopReason ?? 'drive-failed',
          observed: { consoleErrors, failedRequests, evidence },
          session: result?.session ? { status: result.session.status, step: result.session.step } : null,
          warnings: result?.warnings ?? [],
          partial: Boolean(partial),
          error: partial?.cause.message ?? null,
        },
      };
    },
  );
```

The pooled browser is borrowed, so `openBrowser` leaves it alive after the recording context closes, the same way `repro_run` borrows it.

- [ ] **Step 5: Run the MCP suite and the type check**

Run: `npx vitest run tests/mcp.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/server.ts src/api.ts src/cli/index.ts tests/mcp.test.ts
git commit -m "Let an agent record through the MCP server

The server could run, list, inspect, extract and delete repros and could not
create one. repro_record runs a drive file in the pooled browser and returns
the steps captured, the bug signature seen while recording, the session
status and, for a driver that threw, the steps it kept.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BgVy4HW385PjgtJLmbc6E8"
```

---

### Task 10: The extraction nudge

**Files:**
- Modify: `src/extract.ts` (append `extractionNudge`)
- Modify: `src/api.ts` exports
- Modify: `src/cli/index.ts` (`record` and `list` actions)
- Modify: `src/mcp/server.ts` (`repro_record` and `repro_list`)
- Test: `tests/mcp.test.ts` (new describe with its own root)

**Interfaces:**
- Produces: `extractionNudge(root?: string): Promise<string[]>`, one line per exact-match candidate shared by at least `config.extractThreshold` repros:
  `4 repros share a 3-step prefix starting at /workspaces — repro extract to make it a shared step`.
- Consumes: `loadConfig` (Task 1), `suggestExtractions`.

- [ ] **Step 1: Write the failing test**

Append to `tests/mcp.test.ts`, after the `warm sessions by default` describe:

```ts
describe('the extraction nudge', () => {
  let nudgeRoot: string;
  let nudgeClient: Client;
  let nudgeReplay: ReturnType<typeof createReplayServer>;

  const nudgeCall = (name: string, args: Record<string, unknown> = {}) =>
    nudgeClient.callTool({ name, arguments: args }) as Promise<ToolResult>;

  beforeAll(async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    nudgeRoot = await mkdtemp(path.join(tmpdir(), 'replay-nudge-'));
    // The default threshold is 4; two repros are enough to prove the mechanism.
    await mkdir(path.join(nudgeRoot, '.repros'), { recursive: true });
    await writeFile(path.join(nudgeRoot, '.repros', 'config.json'), '{ "extractThreshold": 2 }', 'utf8');
    for (const name of ['first-issue', 'second-issue']) {
      await server.reset();
      await record({ name, baseUrl: server.baseUrl, root: nudgeRoot, headless: true, drive: demoBugFlow });
    }
    const [c, s] = InMemoryTransport.createLinkedPair();
    nudgeClient = new Client({ name: 'test-agent', version: '1.0.0' });
    nudgeReplay = createReplayServer(nudgeRoot);
    await Promise.all([nudgeReplay.server.connect(s), nudgeClient.connect(c)]);
  }, 120_000);

  afterAll(async () => {
    await nudgeReplay?.dispose();
    await nudgeClient?.close();
    if (nudgeRoot) await rm(nudgeRoot, { recursive: true, force: true });
  });

  it('appears in repro_list once the configured number of repros share a prefix', async () => {
    const lines = await extractionNudge(nudgeRoot);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^2 repros share a \d+-step prefix starting at \/ — repro extract/);

    const listed = await nudgeCall('repro_list');
    expect(listed.content.map((c) => c.text ?? '').join('\n')).toContain(lines[0]);
  });

  it('never appears in repro_run, which stays about the bug', async () => {
    await server.reset();
    const ran = await nudgeCall('repro_run', { name: 'first-issue', reuse: false });
    expect(ran.content.map((c) => c.text ?? '').join('\n')).not.toMatch(/repros share/);
  });

  it('disappears once the prefix has been extracted', async () => {
    const applied = await nudgeCall('repro_extract', { name: 'demo-preamble' });
    expect(applied.isError).toBeFalsy();
    expect(await extractionNudge(nudgeRoot)).toEqual([]);
    const listed = await nudgeCall('repro_list');
    expect(listed.content.map((c) => c.text ?? '').join('\n')).not.toMatch(/repros share/);
  });
});
```

Add `extractionNudge` to the `../src/api.js` import at the top of the file, and `mkdtemp`/`tmpdir` are already imported there.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mcp.test.ts -t "extraction nudge"`
Expected: FAIL, `extractionNudge` is not exported.

- [ ] **Step 3: Implement the nudge**

Append to `src/extract.ts` (add `import { loadConfig } from './config.js';` at the top):

```ts
/**
 * One line per prefix shared by at least `extractThreshold` repros.
 *
 * The threshold is the project's, so a team decides once how much repetition
 * is worth a shared step. Only exact matches count: a near match still needs
 * a hand to parameterize it, and nudging toward a rewrite that will be
 * refused helps nobody. Nothing here writes.
 */
export async function extractionNudge(root = process.cwd()): Promise<string[]> {
  const { extractThreshold } = await loadConfig(root);
  const { suggestions } = await suggestExtractions({ root, minRepros: extractThreshold });
  return suggestions
    .filter((s) => s.repros.length >= extractThreshold)
    .map(
      (s) =>
        `${s.repros.length} repros share a ${s.stepCount}-step prefix starting at ${s.startPath} — ` +
        'repro extract to make it a shared step',
    );
}
```

In `src/api.ts`, add `extractionNudge` to the block that already re-exports `applyExtract` and `suggestExtractions` from `./extract.js`.

- [ ] **Step 4: Show it where the spec says**

`src/cli/index.ts`: add `extractionNudge` to the `../api.js` import. In the `record` action, after the warnings loop:

```ts
    for (const line of await extractionNudge()) console.log(`  ${dim('→')} ${line}`);
```

In the `list` action, after `console.log(table(rows));`:

```ts
    for (const line of await extractionNudge()) console.log(dim(`  ${line}`));
```

`src/mcp/server.ts`: add `extractionNudge` to the `../api.js` import. In `repro_record`, before the `Next:` line is pushed (inside `if (!partial)`):

```ts
      if (!partial) for (const line of await extractionNudge(root)) lines.push(line);
```

In `repro_list`, replace the final return:

```ts
      const nudges = await extractionNudge(root);
      return {
        content: [{ type: 'text', text: [...lines, ...nudges].join('\n') }],
        structuredContent: { repros, nudges },
      };
```

- [ ] **Step 5: Run the MCP suite and the type check**

Run: `npx vitest run tests/mcp.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/extract.ts src/api.ts src/cli/index.ts src/mcp/server.ts tests/mcp.test.ts
git commit -m "Say when enough repros share a prefix to be worth extracting

Extraction waited to be asked. After a recording and in the listings, one
line now reports a prefix shared by at least the configured number of repros.
Suggest still writes nothing, and repro_run stays about the bug.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BgVy4HW385PjgtJLmbc6E8"
```

---

### Task 11: `repro init`, and the project state as MCP `instructions`

**Files:**
- Create: `src/agent-notes.ts`, `src/init.ts`
- Modify: `src/mcp/server.ts:129-134` (async creation, `instructions`), `src/mcp/server.ts` (`repro_steps` warning text), `src/mcp/index.ts:13`
- Modify: `src/cli/index.ts` (new `init` command)
- Modify: `src/api.ts` exports
- Modify: `tests/mcp.test.ts` (await the async creation; new describe)
- Test: `tests/init.test.ts`

**Interfaces:**
- Produces:
  - `AGENT_WORKFLOW: string`, `MCP_CONFIG_SNIPPET: string`, `renderProjectSnapshot(root): Promise<string>`, `buildInstructions(root): Promise<string>`
  - `GITIGNORE_BLOCK: string[]`, `initProject(root?): Promise<{ changes: string[] }>`
  - `createReplayServer(root?): Promise<ReplayServer>`, `createServer(root?): Promise<McpServer>`
  - CLI `repro init`
- Consumes: `loadSteps`, `listRepros`, `readRepro`, `parseSessionPath`, `readMeta`, `SESSIONS_DIR`, `extractionNudge`, `CONFIG_FILE`, `DEFAULT_CONFIG`, `STEPS_DIR`, `age` from `src/cli/format.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/init.test.ts
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_WORKFLOW, MCP_CONFIG_SNIPPET } from '../src/agent-notes.js';
import { GITIGNORE_BLOCK, initProject } from '../src/init.js';

/**
 * repro init draws the line through .repros/: steps and config are committed,
 * repros and sessions are not. It is idempotent and prints every change.
 */

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'replay-init-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('repro init', () => {
  it('writes the ignore rules, the default config and the steps dir', async () => {
    const { changes } = await initProject(root);
    const ignore = await readFile(path.join(root, '.gitignore'), 'utf8');
    for (const line of GITIGNORE_BLOCK) expect(ignore.split('\n')).toContain(line);
    expect(ignore.endsWith('\n')).toBe(true);
    expect(JSON.parse(await readFile(path.join(root, '.repros/config.json'), 'utf8'))).toEqual({
      extractThreshold: 4,
    });
    expect(existsSync(path.join(root, '.repros/steps'))).toBe(true);
    expect(changes.join('\n')).toMatch(/\.gitignore: added 3 rules/);
    expect(changes.join('\n')).toMatch(/wrote \.repros\/config\.json/);
  });

  it('runs twice without duplicating anything', async () => {
    await initProject(root);
    const before = await readFile(path.join(root, '.gitignore'), 'utf8');
    await writeFile(path.join(root, '.repros/config.json'), '{ "extractThreshold": 7 }', 'utf8');
    const { changes } = await initProject(root);
    expect(await readFile(path.join(root, '.gitignore'), 'utf8')).toBe(before);
    expect(await readFile(path.join(root, '.repros/config.json'), 'utf8')).toBe('{ "extractThreshold": 7 }');
    expect(changes.join('\n')).toMatch(/already ignores/);
    expect(changes.join('\n')).toMatch(/already exists/);
  });

  it('appends to an existing .gitignore without touching its content', async () => {
    await writeFile(path.join(root, '.gitignore'), 'node_modules/\ndist', 'utf8');
    await initProject(root);
    const ignore = await readFile(path.join(root, '.gitignore'), 'utf8');
    expect(ignore.startsWith('node_modules/\ndist\n')).toBe(true);
    expect(ignore).toContain(`\n${GITIGNORE_BLOCK.join('\n')}\n`);
  });

  it('carries the workflow an agent needs, and the same text the server sends', () => {
    for (const tool of ['repro_steps', 'repro_record', 'repro_run', 'repro_extract', 'repro_delete']) {
      expect(AGENT_WORKFLOW).toContain(tool);
    }
    expect(AGENT_WORKFLOW).toContain('expect_fixed');
    expect(AGENT_WORKFLOW).toContain('COULD NOT VERIFY');
    expect(JSON.parse(MCP_CONFIG_SNIPPET)).toEqual({
      mcpServers: { replay: { command: 'npx', args: ['repro-mcp'] } },
    });
  });
});
```

In `tests/mcp.test.ts`, the server is now created asynchronously. Change the two type annotations and the two creations:

```ts
let replay: Awaited<ReturnType<typeof createReplayServer>>;
// ...
  replay = await createReplayServer(root);
```

```ts
  let nudgeReplay: Awaited<ReturnType<typeof createReplayServer>>;
// ...
    nudgeReplay = await createReplayServer(nudgeRoot);
```

Append a new describe at the end of `tests/mcp.test.ts`:

```ts
describe('what the agent knows before its first call', () => {
  let knownRoot: string;
  let knownClient: Client;
  let knownReplay: Awaited<ReturnType<typeof createReplayServer>>;

  beforeAll(async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    knownRoot = await mkdtemp(path.join(tmpdir(), 'replay-known-'));
    const stepsDir = path.join(knownRoot, '.repros', 'steps');
    const sessionsDir = path.join(knownRoot, '.repros', 'sessions');
    await mkdir(stepsDir, { recursive: true });
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      path.join(stepsDir, 'signed-in.mjs'),
      `export default {
        name: 'signed-in',
        description: 'Signed in as the seed account',
        establishesSession: true,
        ensures: '[data-testid="signed-in-badge"]',
        async run() {},
      };`,
      'utf8',
    );
    await writeFile(
      path.join(stepsDir, 'no-check.mjs'),
      `export default {
        name: 'no-check',
        description: 'A session step with no ensures',
        establishesSession: true,
        async run() {},
      };`,
      'utf8',
    );
    await writeFile(
      path.join(sessionsDir, 'signed-in@localhost_5240.json'),
      JSON.stringify({
        cookies: [],
        origins: [{ origin: server.baseUrl, localStorage: [{ name: 'replay-token', value: 'ok' }] }],
      }),
      'utf8',
    );
    await writeFile(
      path.join(sessionsDir, 'signed-in@localhost_5240.meta.json'),
      JSON.stringify({ mintedAt: new Date().toISOString(), provenPaths: ['/'] }),
      'utf8',
    );
    await server.reset();
    await record({ name: 'known-bug', baseUrl: server.baseUrl, root: knownRoot, headless: true, drive: demoBugFlow });

    const [c, s] = InMemoryTransport.createLinkedPair();
    knownClient = new Client({ name: 'test-agent', version: '1.0.0' });
    knownReplay = await createReplayServer(knownRoot);
    await Promise.all([knownReplay.server.connect(s), knownClient.connect(c)]);
  }, 120_000);

  afterAll(async () => {
    await knownReplay?.dispose();
    await knownClient?.close();
    if (knownRoot) await rm(knownRoot, { recursive: true, force: true });
  });

  it('sends the workflow and the project snapshot as instructions', () => {
    const text = knownClient.getInstructions() ?? '';
    expect(text).toContain('repro_record');
    expect(text).toContain('signed-in — Signed in as the seed account');
    expect(text).toMatch(/\[session\]/);
    expect(text).toMatch(/stored session: localhost_5240/);
    expect(text).toContain('known-bug — ');
    expect(text).toContain(`Recorded against: ${server.baseUrl}`);
    expect(text).toMatch(/no-check — .*verifies nothing/);
  });

  it('says a session step without ensures cannot share its session', async () => {
    const result = (await knownClient.callTool({ name: 'repro_steps', arguments: {} })) as ToolResult;
    const text = result.content.map((c) => c.text ?? '').join('\n');
    expect(text).toMatch(/no-check.*session cannot be shared/);
    expect(text).not.toMatch(/signed-in.*WARNING/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/init.test.ts tests/mcp.test.ts`
Expected: FAIL, `Cannot find module '../src/agent-notes.js'` and `'../src/init.js'`; `getInstructions()` is undefined.

- [ ] **Step 3: Create `src/agent-notes.ts`**

```ts
// src/agent-notes.ts
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { age } from './cli/format.js';
import { extractionNudge } from './extract.js';
import { listRepros, readRepro } from './ir/io.js';
import { parseSessionPath, readMeta, SESSIONS_DIR } from './sessions.js';
import { loadSteps, STEPS_DIR } from './steps.js';

/**
 * What an agent should know before its first tool call.
 *
 * Sent as the MCP server's `instructions` and printed by `repro init` for
 * CLAUDE.md, from one string so the two cannot drift. The snapshot is names
 * and one-line descriptions only, never IR bodies: it has to fit in the
 * agent's context beside the actual issue.
 */

export const MCP_CONFIG_SNIPPET =
  '{ "mcpServers": { "replay": { "command": "npx", "args": ["repro-mcp"] } } }';

export const AGENT_WORKFLOW = `fast-replay records a browser bug once and replays it deterministically in seconds, with no model in the loop. Use it instead of driving the browser step by step through every verification.

Workflow for one issue:
1. repro_steps: see the shared setup steps this project already has (sign-in, navigation to a screen). Reuse them; write a new one under .repros/steps/ only when nothing reaches the state you need.
2. Write a drive file at .repros/drive/<name>.mjs:
     import { defineDrive } from 'fast-replay';
     export default defineDrive({
       setup: [{ step: 'signed-in' }],
       async drive(page, { step, observe }) { /* Playwright to the bug; observe('<selector>') names the evidence while it is on screen */ },
     });
   then call repro_record. Declare the sign-in step in setup so the project's stored session is reused instead of signing in again.
3. Fix the code, then repro_run with expect_fixed=true after every change. BUG FIXED means done. COULD NOT VERIFY means the harness could not drive the app and says nothing about the bug; read the failing step before touching the fix.
4. When repro_list or repro_record says several repros share a prefix, repro_extract turns it into a shared step so the next issue starts faster. You name the step.
5. repro_delete once the fix is confirmed. Repros are disposable; steps, config and sessions stay.`;

interface StoredSession {
  key: string;
  host: string;
  age: string;
}

async function storedSessions(root: string): Promise<StoredSession[]> {
  const dir = path.join(root, SESSIONS_DIR);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const found: StoredSession[] = [];
  for (const entry of entries) {
    const parsed = parseSessionPath(path.join(dir, entry));
    if (!parsed) continue;
    const meta = readMeta(path.join(dir, entry.replace(/\.json$/, '.meta.json')));
    const minted = meta.mintedAt || (await stat(path.join(dir, entry))).mtime.toISOString();
    found.push({ key: parsed.key, host: parsed.host, age: age(minted) });
  }
  return found;
}

/** Steps, stored sessions, repros, origins and pending extractions, as a few lines. */
export async function renderProjectSnapshot(root: string): Promise<string> {
  const lines: string[] = ['This project right now:'];

  const { steps, errors } = await loadSteps(path.join(root, STEPS_DIR));
  const sessions = await storedSessions(root);
  lines.push(`Shared steps (${steps.size}):`);
  if (!steps.size) lines.push('  none yet');
  for (const s of steps.values()) {
    const tags = [
      s.establishesSession ? 'session' : null,
      s.requires?.length ? `requires: ${s.requires.join(', ')}` : null,
      s.ensures ? null : 'verifies nothing',
    ].filter((t): t is string => Boolean(t));
    lines.push(`  ${s.name} — ${s.description}${tags.length ? ` [${tags.join('; ')}]` : ''}`);
    const stored = sessions.filter((x) => x.key === s.name || x.key.startsWith(`${s.name}.`));
    if (stored.length) {
      lines.push(`    stored session: ${stored.map((x) => `${x.host} (${x.age} old)`).join(', ')}`);
    }
  }
  for (const e of errors) lines.push(`  ${e.file} could not be loaded: ${e.message}`);

  const repros = await listRepros(root);
  lines.push(`Repros (${repros.length}):`);
  if (!repros.length) lines.push('  none yet');
  const origins = new Set<string>();
  for (const r of repros) {
    const last = r.lastResult ? `${r.lastResult.status} ${age(r.lastResult.at)} ago` : 'never run';
    lines.push(`  ${r.name} — ${r.steps ?? '?'} steps, last run: ${last}${r.error ? ` (INVALID: ${r.error})` : ''}`);
    if (r.error) continue;
    try {
      origins.add(new URL((await readRepro(r.name, root)).baseUrl).origin);
    } catch {
      // Already reported through r.error on the next listing.
    }
  }
  if (origins.size) lines.push(`Recorded against: ${Array.from(origins).join(', ')}`);

  try {
    lines.push(...(await extractionNudge(root)));
  } catch (err) {
    // A broken config must not take the server down with it.
    lines.push((err as Error).message);
  }
  return lines.join('\n');
}

export async function buildInstructions(root: string): Promise<string> {
  return `${AGENT_WORKFLOW}\n\n${await renderProjectSnapshot(root)}`;
}
```

Check that `age` in `src/cli/format.ts` accepts an ISO string and returns a short duration; it is already used by `repro list` for exactly this.

- [ ] **Step 4: Create `src/init.ts`**

```ts
// src/init.ts
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_FILE, DEFAULT_CONFIG } from './config.js';
import { STEPS_DIR } from './steps.js';

/**
 * The line through .repros/: repros, sessions, drive files and artifacts are
 * disposable and hold tokens; steps and config are the durable, shared part.
 * `.repros/*` with two exceptions is the only shape git accepts for that, since
 * a directory ignored as a whole cannot have a child re-included.
 */
export const GITIGNORE_BLOCK = [
  '# fast-replay: repros and sessions are disposable and hold tokens; steps and config are shared',
  '.repros/*',
  '!.repros/steps/',
  '!.repros/config.json',
];

export interface InitReport {
  changes: string[];
}

/** Idempotent. Every change made is named in the report; nothing else is touched. */
export async function initProject(root = process.cwd()): Promise<InitReport> {
  const changes: string[] = [];

  const ignoreFile = path.join(root, '.gitignore');
  let existing = '';
  try {
    existing = await readFile(ignoreFile, 'utf8');
  } catch {
    // No .gitignore yet; one is created below.
  }
  if (existing.split(/\r?\n/).includes('.repros/*')) {
    changes.push('.gitignore already ignores .repros/* (left unchanged)');
  } else {
    const glue = existing.length === 0 ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
    await writeFile(ignoreFile, `${existing}${glue}${GITIGNORE_BLOCK.join('\n')}\n`, 'utf8');
    changes.push(
      `.gitignore: added ${GITIGNORE_BLOCK.length - 1} rules (repros and sessions ignored, steps and config committed)`,
    );
  }

  const configFile = path.join(root, CONFIG_FILE);
  if (existsSync(configFile)) {
    changes.push(`${CONFIG_FILE} already exists (left unchanged)`);
  } else {
    await mkdir(path.dirname(configFile), { recursive: true });
    await writeFile(configFile, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, 'utf8');
    changes.push(`wrote ${CONFIG_FILE}`);
  }

  await mkdir(path.join(root, STEPS_DIR), { recursive: true });
  changes.push(`${STEPS_DIR}/ ready for shared steps`);

  return { changes };
}
```

- [ ] **Step 5: Make server creation async and send the instructions**

In `src/mcp/server.ts`, import `buildInstructions` from `../agent-notes.js` and replace the two factory functions:

```ts
export async function createServer(root = process.cwd()): Promise<McpServer> {
  return (await createReplayServer(root)).server;
}

export async function createReplayServer(root = process.cwd()): Promise<ReplayServer> {
  // Instructions travel in the initialize response, so this is the one moment
  // the project's state can reach the agent before its first tool call.
  const server = new McpServer(
    { name: 'replay', version: VERSION },
    { instructions: await buildInstructions(root) },
  );
```

In the `repro_steps` handler, replace the warning suffix:

```ts
          (s.ensures
            ? ''
            : s.establishesSession
              ? ' [WARNING: verifies nothing, so a break here surfaces elsewhere and its session cannot be shared]'
              : ' [WARNING: verifies nothing, so a break here surfaces elsewhere]'),
```

In `src/mcp/index.ts`:

```ts
const { server, dispose } = await createReplayServer(root);
```

- [ ] **Step 6: Add the `init` command and the exports**

In `src/api.ts`:

```ts
export { AGENT_WORKFLOW, buildInstructions, MCP_CONFIG_SNIPPET, renderProjectSnapshot } from './agent-notes.js';
export { GITIGNORE_BLOCK, initProject, type InitReport } from './init.js';
export { CONFIG_FILE, DEFAULT_CONFIG, loadConfig, type Config } from './config.js';
```

In `src/cli/index.ts`, add `AGENT_WORKFLOW, initProject, MCP_CONFIG_SNIPPET` to the `../api.js` import and register, before the `record` command:

```ts
program
  .command('init')
  .description('set up .repros/ once per project: ignore rules, config, steps dir, and what to tell your agent')
  .action(async () => {
    const { changes } = await initProject();
    for (const change of changes) console.log(`  ${green('✓')} ${change}`);
    console.log('');
    console.log(bold('Add to your MCP client config:'));
    console.log(`  ${MCP_CONFIG_SNIPPET}`);
    console.log('');
    console.log(bold('Add to CLAUDE.md, or wherever your agent reads project notes:'));
    console.log('');
    console.log(AGENT_WORKFLOW);
  });
```

- [ ] **Step 7: Run the tests and the type check**

Run: `npx vitest run tests/init.test.ts tests/mcp.test.ts && npm run typecheck`
Expected: PASS, no type errors. Also run `npx tsx src/cli/index.ts init` inside a scratch directory and read the output once.

- [ ] **Step 8: Commit**

```bash
git add src/agent-notes.ts src/init.ts src/mcp/server.ts src/mcp/index.ts src/cli/index.ts src/api.ts tests/init.test.ts tests/mcp.test.ts
git commit -m "Tell the agent what the project has before its first call, and add repro init

The MCP server now sends the workflow and a snapshot of steps, stored
sessions, repros and pending extractions as its instructions. repro init
draws the line through .repros/ so steps and config are committed while
repros and sessions stay out of git, and prints the same workflow for
CLAUDE.md.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BgVy4HW385PjgtJLmbc6E8"
```

---

### Task 12: Docs, version, and the full run

**Files:**
- Modify: `README.md` (Use block, coding-agent section, shared-steps session paragraph), `CLAUDE.md` (architecture section), `CHANGELOG.md` (new entry at top), `package.json` (`version`), `docs/superpowers/specs/2026-09-02-agent-workflow-design.md` (host slug line)

- [ ] **Step 1: README, the Use block**

Replace the `## Use` code block with:

```bash
repro init                                                # once per project: ignore rules, config, agent notes
repro record checkout-crash --url http://localhost:3000   # click the bug once
repro run checkout-crash                                  # bug still reproduces?
repro run checkout-crash --expect-fixed                   # did my fix work?
repro list
repro watch checkout-crash --expect-fixed                 # fix-verify loop
repro rm checkout-crash                                   # once it's fixed
```

- [ ] **Step 2: README, the coding-agent section**

The README is the front page of an open-source npm package: keep it as short as it can be. Replace the `## From a coding agent` section (heading through the `Works with Claude Code, Codex, Gemini CLI, Cursor.` line) with:

````markdown
## From a coding agent

```json
{ "mcpServers": { "replay": { "command": "npx", "args": ["repro-mcp"] } } }
```

`repro init` prints that line, sets up `.repros/` (steps and config committed, repros and sessions ignored) and prints a short workflow for CLAUDE.md. The server sends the same workflow, plus the project's steps, sessions and repros, as its `instructions`, so an agent starts informed.

An agent records with a drive file, in one call:

```js
// .repros/drive/checkout-crash.mjs
import { defineDrive } from 'fast-replay';

export default defineDrive({
  setup: [{ step: 'signed-in' }],   // seeded from the stored session, not re-run
  async drive(page, { observe }) {
    await page.click('[data-testid="checkout"]');
    await observe('text=Something went wrong');
  },
});
```

`repro_record` runs it headless; `repro record <name> --url <base> --drive <file>` is the same from the CLI. `repro_run` returns the verdict, the failing step, console, network and **the page as an inline image** — in one call. Works with Claude Code, Codex, Gemini CLI, Cursor.
````

- [ ] **Step 3: README, sessions**

Replace the paragraph starting `**A sign-in step should establish the session, not replay itself.**`, its code block, and the `(repro record --profile ...)` line, with:

````markdown
**A sign-in step establishes a session once per project.** Mark it `establishesSession: true` and give it an `ensures` that is visible on every signed-in page (an account menu, not a home-screen element). The first recording signs in and stores the session under `.repros/sessions/`; later recordings and every replay restore it and skip the step. When the token expires, replay signs in once more, replaces the stored session and says so in its notes.

```ts
export default defineStep({
  name: 'signed-in',
  description: 'Signed in as the seed account',
  establishesSession: true,
  ensures: '[data-testid="account-menu"]',
  async run(page) { /* credentials from process.env */ },
});
```

Session files hold tokens and are never committed; `repro init` writes the ignore rules. (`repro record --profile ./.replay-profile` does the same for a fully manual recording.)
````

In the Flag table add one row and leave the rest alone:

```
| `--drive <file>` | record by running a drive file, headless; `--headed` to watch |
```

Nothing else in the README changes. The `sessionCheck` mechanics, the proof rule and the layout details live in CLAUDE.md and the CHANGELOG, not on the front page.

- [ ] **Step 4: CLAUDE.md**

In the Architecture section, after the **Shared setup steps** paragraph, add:

```markdown
**Project sessions** (`src/sessions.ts`): a session belongs to the project and the account, not to the repro. A recording declares its setup (`RecordOptions.setup`, or `setup` in a drive file); `planSession` decides before the browser opens whether to seed `.repros/sessions/<key>@<host>.json`, and it seeds only on a start path the meta sidecar lists as proven. `establishSession` is the one routine for record and replay: probe the step's `ensures`, sign in for real when it fails, capture, record proof. Replay probes only a repro carrying `sessionCheck`, heals once, and notes it; without the mark it restores and skips as before. Nothing probes without proof, because a probe on a path where `ensures` is never visible would sign in on every run.

**Drive files** (`src/drive.ts`): `defineDrive({ setup, drive })` in `.repros/drive/<name>.mjs`, run by `repro record --drive` and the MCP `repro_record`. Same IR as a programmatic `record()`. User modules (steps and drive files) are imported through `src/import-fresh.ts`, which puts the file's mtime in the URL so the long-lived MCP server sees edits.

**Config and layout** (`src/config.ts`, `src/init.ts`, `src/agent-notes.ts`): `.repros/config.json` holds `extractThreshold`. `repro init` writes `.repros/*` plus two exceptions to `.gitignore` so steps and config are committed while repros, sessions and drive files are not. `AGENT_WORKFLOW` is both what `repro init` prints for CLAUDE.md and the MCP server's `instructions`, followed by a snapshot of steps, stored sessions, repros and pending extractions. The extraction nudge (`extractionNudge`) appears after a recording and in listings, never in a run result.
```

Add to the Commands block: `repro init` is not a dev command, so nothing there; add to Testing conventions: `tests/sessions.test.ts` runs two demo servers (5445 and 5446) to prove `--env` healing.

- [ ] **Step 5: CHANGELOG and version**

Set `"version": "0.13.0"` in `package.json`. Add at the top of `CHANGELOG.md`:

```markdown
## 0.13.0 — 2026-09-02

### Agents record too

The MCP server could run, list, inspect, extract and delete repros and could not create one, so an agent that had just walked to a bug with Playwright had to hand-write a Node script against the API. `repro_record` runs a drive file — `defineDrive({ setup, drive })` at `.repros/drive/<name>.mjs` — in the pooled browser and returns the steps captured, the bug signature seen while recording, the session status and, when the driver threw, the steps it kept. `repro record --drive` is the same path from the CLI, headless by default. The IR is the one a human recording produces.

Step and drive files are imported with their mtime in the URL, so a file edited between two calls to the long-lived server runs the edited version. Before this, a step fixed while the server ran was not picked up until restart.

### One session per project

A session-establishing step ran once per recording, so ten issues still meant ten sign-ins, and an expired token surfaced as an unrelated step failure somewhere later. A recording now declares its setup; the session step is seeded from `.repros/sessions/<step>@<host>.json` and skipped when the stored session proves alive, and signs in for real otherwise. Replay verifies the step's `ensures` on the start path, runs the step once when it has expired, replaces the stored session and says so in the notes. Under `--env` the target host gets its own session file.

The guard that makes this safe: nothing probes without proof. A probe on a start path where `ensures` is never visible would time out and sign in on every run, which is the failure this exists to remove. Record time proves the check per start path and marks the repro `sessionCheck` only when it held; a repro without the mark, including every repro from an earlier release, restores and skips exactly as before. Name something visible on every signed-in page in a session step's `ensures`.

Two small fixes on the way: a navigation performed by a setup step is no longer captured, so a sign-in that reloads stops leaving a `goto` step in the IR; and a repro cannot be named `config`, `steps`, `sessions` or `drive`.

### `repro init`, and knowing the project before the first call

Steps lived inside a directory most projects ignore as a whole, so the one durable thing in `.repros/` did not travel with the repo. `repro init` writes `.repros/*` with exceptions for `steps/` and `config.json` to `.gitignore`, writes the config, and prints the MCP client line plus a workflow block for CLAUDE.md. The MCP server sends that same workflow as its `instructions`, followed by the project's steps, stored sessions, repros and pending extractions, so an agent starts informed rather than discovering the project one tool call at a time.

`.repros/config.json` holds `extractThreshold` (default 4). Once that many repros share a prefix, `repro record`, `repro_record`, `repro list` and `repro_list` say so in one line. Extraction is still applied only by an explicit, named call, and `repro_run` stays about the bug.
```

- [ ] **Step 6: Spec amendment**

In `docs/superpowers/specs/2026-09-02-agent-workflow-design.md`, section "Where it lives", change the `host` bullet to:

```markdown
- `host`: `URL.host` of the origin the session was minted against, port included, with `:` written as `_` so the file name is legal on every platform (`localhost_3000`).
```

and update the example file names in that section to `signed-in@localhost_3000.json` and `signed-in@localhost_3000.meta.json`.

- [ ] **Step 7: Full verification**

Run, in order:

```bash
npm run typecheck
npm test
npm run build
node dist/cli/index.js --help | grep -E 'init|record'
```

Expected: no type errors; every suite green (the run takes several minutes and needs the demo app dependencies installed); `dist/` rebuilt with the agent bundle fresh; `--help` lists `init` and `record`.

- [ ] **Step 8: Commit**

```bash
git add README.md CLAUDE.md CHANGELOG.md package.json docs/superpowers/specs/2026-09-02-agent-workflow-design.md
git commit -m "Document project sessions, drive files and repro init, and cut 0.13.0

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BgVy4HW385PjgtJLmbc6E8"
```

---

## Self-review against the spec

**Spec coverage.**

| Spec section | Task |
|---|---|
| 1 Layout: `.repros/drive/`, `.repros/sessions/`, deleted with repro | 5, 8 |
| 1 Config: `extractThreshold`, defaults, errors name file and field | 1 |
| 1 `repro init`: ignore block, config, steps dir, two snippets, idempotent | 11 |
| 2 Session files, key with params hash, host, meta sidecar with `provenPaths` | 5 |
| 2 Record time: proven path probes, unproven signs in, proof recorded, `sessionCheck` | 5, 6, 3 |
| 2 Explicit seed wins; two session steps disable; no `ensures` disables | 5, 6 |
| 2 `api.step()` on a session step leaves a shared file | 6 |
| 2 Replay: probe only with `sessionCheck`, heal once, note, `COULD NOT VERIFY` on failure | 7 |
| 2 `--env` target-host file first, heal writes target host | 7 |
| 2 `--profile` heals without writing | 7 |
| 2 Warm sessions through `openSession` and `resolveSessionSeed` | 7 (MCP suite) |
| 2 Compatibility: no IR bump, old repros unchanged | 3, 7 |
| 3 `defineDrive`, `loadDrive`, refusal by name | 8 |
| 3 CLI `--drive`, `--headed`, headless default | 8 |
| 3 `repro_record` output and `structuredContent`, partial recordings | 9 |
| 3 Module cache busting for drive and step files | 2, 9 |
| 4 `instructions` = workflow + snapshot, async creation | 11 |
| 4 Nudge in record, `repro_record`, list, `repro_list`; never in `repro_run` | 10 |
| 5 Fixture badge; global `ensures`; tests per section | 4, 6, 7, 8, 9, 10, 11 |
| 5 Docs, CHANGELOG, 0.13.0 | 12 |

**Placeholder scan.** Every code step carries its code. No "similar to", no "add handling".

**Type consistency.** `SessionOutcome` (Task 6) is what `RecordResult.session` (Task 6), `describeSession` (Task 8) and `repro_record` (Task 9) consume. `SessionTarget.files.meta` is `string | null` in Task 5 and used as such by `replaySessionTarget` (Task 7) and `persistSession` (Task 5). `establishSession` takes `startPath` and `startUrl` in both call sites (Tasks 6 and 7). `extractionNudge(root)` (Task 10) is what `renderProjectSnapshot` (Task 11) calls. `createReplayServer` is async from Task 11 on, and Task 10's test types are updated in Task 11.

**Deviation from the spec, recorded in Task 12:** the host in a session file name is written with `_` for `:`.
