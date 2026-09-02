import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createReplayServer, extractionNudge, record } from '../src/api.js';
import { startDemoServer, type DemoServer } from './helpers/demo-server.js';
import { demoBugFlow } from './helpers/flow.js';

/**
 * The MCP surface is what a coding agent actually sees, so it is exercised
 * through a real client over a real transport rather than by calling the
 * handlers directly.
 */

interface ToolResult {
  content: ({ type: string; text?: string; data?: string; mimeType?: string })[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

let server: DemoServer;
let root: string;
let client: Client;
let replay: Awaited<ReturnType<typeof createReplayServer>>;

beforeAll(async () => {
  server = await startDemoServer(5240);
  root = await mkdtemp(path.join(tmpdir(), 'replay-mcp-'));

  await record({
    name: 'checkout-crash',
    baseUrl: server.baseUrl,
    root,
    headless: true,
    drive: demoBugFlow,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-agent', version: '1.0.0' });
  replay = await createReplayServer(root);
  await Promise.all([replay.server.connect(serverTransport), client.connect(clientTransport)]);
}, 120_000);

afterAll(async () => {
  await replay?.dispose();
  await client?.close();
  await server?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

const call = (name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args }) as Promise<ToolResult>;

describe('mcp server', () => {
  it('advertises the tools an agent needs', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'repro_artifacts',
      'repro_delete',
      'repro_extract',
      'repro_list',
      'repro_record',
      'repro_run',
      'repro_steps',
    ]);
    // The description is the only thing steering an agent toward using it.
    const run = tools.find((t) => t.name === 'repro_run');
    expect(run?.description).toMatch(/after every code change/i);
    expect(run?.description).toMatch(/expect_fixed/);
  });

  it('lists repros', async () => {
    const result = await call('repro_list');
    expect(result.content[0]?.text).toContain('checkout-crash');
    expect((result.structuredContent?.repros as unknown[]).length).toBe(1);
  });

  it('verifies in one call and returns the page as an image', async () => {
    await server.reset();
    const result = await call('repro_run', { name: 'checkout-crash' });

    expect(result.isError).toBeFalsy();
    // The verdict speaks about the bug, not about pass/fail: an agent reading
    // "FAIL" for a successful fix loops on code that is already correct.
    expect(result.content[0]?.text).toMatch(/^BUG REPRODUCED/);
    expect(result.structuredContent?.passed).toBe(true);
    expect(result.structuredContent?.totalSteps).toBe(10);

    // The eye: the model sees the resulting page, not a path to a PNG.
    const image = result.content.find((c) => c.type === 'image');
    expect(image, 'expected an inline screenshot').toBeDefined();
    expect(image?.mimeType).toBe('image/png');
    expect(Buffer.from(image!.data!, 'base64').subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it('reports a failure with the step, its meaning, and a screenshot', async () => {
    await server.reset();
    // Stand in for a code change that moved the button.
    const { readFile, writeFile } = await import('node:fs/promises');
    const irPath = path.join(root, '.repros/checkout-crash.json');
    const original = await readFile(irPath, 'utf8');
    const repro = JSON.parse(original);
    const target = repro.steps.find((s: { target?: { semantic: string } }) =>
      s.target?.semantic.includes('Delete Sensor 2'),
    );
    target.target.candidates = ['[data-testid="gone"]'];
    await writeFile(irPath, JSON.stringify(repro, null, 2));

    try {
      const result = await call('repro_run', { name: 'checkout-crash' });

      expect(result.isError).toBe(true);
      const failure = result.structuredContent?.failure as Record<string, unknown>;
      expect(failure.stepId).toBe(target.id);
      // The semantic description is what lets an agent locate the code.
      expect(failure.semantic).toContain('Delete Sensor 2');
      expect(failure.observed).toContain('gone');
      expect(result.content.some((c) => c.type === 'image')).toBe(true);
    } finally {
      await writeFile(irPath, original);
    }
  });

  it('refuses to certify a fix when the repro states no criterion', async () => {
    // A green here would mean "we checked nothing and it passed".
    await server.reset();
    const result = await call('repro_run', { name: 'checkout-crash', expect_fixed: true });

    expect(result.isError).toBe(true);
    const failure = result.structuredContent?.failure as Record<string, unknown>;
    expect(failure.semantic).toBe('fix criterion');
    expect(String(failure.observed)).toMatch(/expectedWhenFixed/);
  });

  it('flips polarity under expect_fixed so green means fixed', async () => {
    await server.reset();
    const { readFile, writeFile } = await import('node:fs/promises');
    const irPath = path.join(root, '.repros/checkout-crash.json');
    const original = await readFile(irPath, 'utf8');
    const repro = JSON.parse(original);
    repro.assertion.expectedWhenFixed = { domAppeared: ['[data-testid="report-result"]'] };
    await writeFile(irPath, JSON.stringify(repro, null, 2));

    try {
      const result = await call('repro_run', { name: 'checkout-crash', expect_fixed: true });
      expect(result.structuredContent?.passed).toBe(true);
      expect(result.content[0]?.text).toMatch(/^BUG FIXED/);
      expect(result.content[0]?.text).toMatch(/did not occur/i);
    } finally {
      await writeFile(irPath, original);
    }
  });

  it('steers the agent to reuse setup before writing more', async () => {
    // An agent starting fresh has no idea what exists and will happily write a
    // fourth sign-in helper, which is how a preamble ends up breaking every
    // repro separately instead of once.
    const steps = (await client.listTools()).tools.find((t) => t.name === 'repro_steps');
    expect(steps?.description).toMatch(/BEFORE writing new setup/i);
    expect(steps?.description).toMatch(/reusing an existing step/i);
  });

  it('tells the agent to clean up once a fix is verified', async () => {
    // Repros are disposable by design. Left behind they rot against a moving
    // app and become tests nobody meant to write.
    const del = (await client.listTools()).tools.find((t) => t.name === 'repro_delete');
    expect(del?.description).toMatch(/disposable/i);
    expect(del?.description).toMatch(/after repro_run/i);
  });

  it('deletes a repro and reports whether it existed', async () => {
    const { readFile, writeFile } = await import('node:fs/promises');
    const irPath = path.join(root, '.repros/checkout-crash.json');
    const backup = await readFile(irPath, 'utf8');
    try {
      const gone = await call('repro_delete', { name: 'checkout-crash' });
      expect(gone.structuredContent?.deleted).toBe(true);

      const again = await call('repro_delete', { name: 'checkout-crash' });
      expect(again.structuredContent?.deleted).toBe(false);
      expect(again.content[0]?.text).toContain('No repro named');
    } finally {
      await writeFile(irPath, backup);
    }
  });

  it('suggests extractions without writing anything', async () => {
    // Only one repro is recorded, so nothing repeats — and a suggest call must
    // never create files.
    const result = await call('repro_extract', {});
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.suggestions).toEqual([]);
    expect(result.content[0]?.text).toContain('No repeated prefix');
    const { existsSync } = await import('node:fs');
    expect(existsSync(path.join(root, '.repros', 'steps'))).toBe(false);
  });

  it('explains a repro without re-running it', async () => {
    const result = await call('repro_artifacts', { name: 'checkout-crash' });
    const text = result.content.map((c) => c.text ?? '').join('\n');

    expect(text).toContain('checkout-crash');
    expect(text).toContain('Delete Sensor 2');
    expect(text).toContain('expect-bug');
  });

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
});

describe('warm sessions by default', () => {
  it('reuses one warm session across calls instead of a fresh browser each time', async () => {
    // One reported issue means running the same repro many times. Each call
    // creating and destroying a context was the reported "starts and ends
    // multiple sessions per issue".
    await server.reset();
    await call('repro_run', { name: 'checkout-crash' });
    const sizeAfterFirst = replay.warmSessions.size;
    const first = Array.from(replay.warmSessions.values());

    await server.reset();
    const result = await call('repro_run', { name: 'checkout-crash' });
    expect(result.structuredContent?.passed).toBe(true);
    expect(replay.warmSessions.size).toBe(sizeAfterFirst);
    // Same session object — reused, not reopened.
    for (const s of first) expect(Array.from(replay.warmSessions.values())).toContain(s);
  });

  it('revalidates a dead warm session instead of handing it out', async () => {
    await server.reset();
    await call('repro_run', { name: 'checkout-crash' });
    for (const session of replay.warmSessions.values()) await session.page.close();

    await server.reset();
    const result = await call('repro_run', { name: 'checkout-crash' });
    expect(result.structuredContent?.passed, JSON.stringify(result.structuredContent)).toBe(true);
  });

  it('keys warm sessions by what shapes them, not by name alone', async () => {
    await server.reset();
    await call('repro_run', { name: 'checkout-crash' });
    const before = replay.warmSessions.size;
    // Same repro, different target: must not be handed the existing session.
    await server.reset();
    const result = await call('repro_run', { name: 'checkout-crash', base_url: server.baseUrl });
    expect(result.structuredContent?.passed).toBe(true);
    expect(replay.warmSessions.size).toBe(before + 1);
  });

  it('setup_command without explicit reuse opts out of the default, without error', async () => {
    await server.reset();
    const before = replay.warmSessions.size;
    const marker = path.join(root, 'mcp-setup-ran.txt');
    const result = await call('repro_run', {
      name: 'checkout-crash',
      setup_command: `printf ran > ${JSON.stringify(marker)}`,
    });
    expect(result.isError).toBeFalsy();
    expect(replay.warmSessions.size, 'a setup_command call must not warm a session').toBe(before);
  });

  it('still refuses an explicit reuse combined with setup_command', async () => {
    const result = await call('repro_run', {
      name: 'checkout-crash',
      reuse: true,
      setup_command: 'true',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.conflict).toBe('reuse+setup_command');
  });

  it('closes warm sessions for a repro when it is deleted', async () => {
    const { readFile, writeFile } = await import('node:fs/promises');
    const irPath = path.join(root, '.repros/checkout-crash.json');
    const backup = await readFile(irPath, 'utf8');
    try {
      await server.reset();
      await call('repro_run', { name: 'checkout-crash' });
      expect(replay.warmSessions.size).toBeGreaterThan(0);
      await call('repro_delete', { name: 'checkout-crash' });
      expect(replay.warmSessions.size).toBe(0);
    } finally {
      await writeFile(irPath, backup);
    }
  });
});

describe('the extraction nudge', () => {
  let nudgeRoot: string;
  let nudgeClient: Client;
  let nudgeReplay: Awaited<ReturnType<typeof createReplayServer>>;

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
    nudgeReplay = await createReplayServer(nudgeRoot);
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
    // Both repros are the same recording, so the shared prefix is the whole
    // flow and extraction refuses to leave a repro with nothing but setup.
    // Taking nine of the ten steps is the --length a caller would choose.
    const applied = await nudgeCall('repro_extract', { name: 'demo-preamble', length: 9 });
    expect(applied.isError).toBeFalsy();
    expect(await extractionNudge(nudgeRoot)).toEqual([]);
    const listed = await nudgeCall('repro_list');
    expect(listed.content.map((c) => c.text ?? '').join('\n')).not.toMatch(/repros share/);
  });

  it('reports a broken config as one line instead of failing the listing', async () => {
    const { readFile, writeFile } = await import('node:fs/promises');
    const configFile = path.join(nudgeRoot, '.repros', 'config.json');
    const original = await readFile(configFile, 'utf8');
    await writeFile(configFile, '{ "extractThreshold": 1 }', 'utf8');
    try {
      const listed = await nudgeCall('repro_list');
      expect(listed.isError).toBeFalsy();
      const text = listed.content.map((c) => c.text ?? '').join('\n');
      expect(text).toContain('first-issue');
      expect(text).toMatch(/Could not check for repeated prefixes: .*extractThreshold/);
    } finally {
      await writeFile(configFile, original, 'utf8');
    }
  });
});

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
