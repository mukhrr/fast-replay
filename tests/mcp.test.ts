import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createReplayServer, record } from '../src/api.js';
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
let replay: ReturnType<typeof createReplayServer>;

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
  replay = createReplayServer(root);
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
