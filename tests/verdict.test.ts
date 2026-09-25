import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readRepro, record, reproPaths, run } from '../src/api.js';
import { startDemoServer, type DemoServer } from './helpers/demo-server.js';
import { demoBugFlow } from './helpers/flow.js';

/**
 * A step whose recorded reaction never arrives means different things by
 * position. Before the last step the flow went somewhere else and never reached
 * the bug, which says nothing about it; on the last step the bug's own reaction
 * is what is missing.
 */

let server: DemoServer;
let root: string;
let original: string;

beforeAll(async () => {
  server = await startDemoServer(5449);
  root = await mkdtemp(path.join(tmpdir(), 'replay-verdict-'));
  await record({ name: 'flow', baseUrl: server.baseUrl, root, headless: true, drive: demoBugFlow });
  original = await readFile(reproPaths('flow', root).ir, 'utf8');
}, 120_000);
afterAll(async () => {
  await server?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

async function withMissingSignalAt(index: (steps: number) => number): Promise<{ stepIndex: number }> {
  await writeFile(reproPaths('flow', root).ir, original);
  const repro = await readRepro('flow', root);
  const at = index(repro.steps.length);
  repro.steps[at]!.waitAfter = { domAppeared: ['[data-testid="never-rendered"]'], timeoutMs: 500 };
  await writeFile(reproPaths('flow', root).ir, JSON.stringify(repro, null, 2));
  return { stepIndex: at };
}

describe('a recorded reaction that never arrives', () => {
  it('is COULD NOT VERIFY before the last step', async () => {
    const { stepIndex } = await withMissingSignalAt(() => 2);
    await server.reset();
    const result = await run({ name: 'flow', root });
    expect(result.passed).toBe(false);
    expect(result.failure?.kind).toBe('infrastructure');
    expect(result.failure?.stepIndex).toBe(stepIndex);
    expect(result.failure?.observed).toMatch(/before reaching the bug/);
  });

  it('is a verdict on the bug at the last step', async () => {
    const { stepIndex } = await withMissingSignalAt((n) => n - 1);
    await server.reset();
    const result = await run({ name: 'flow', root });
    expect(result.passed).toBe(false);
    expect(result.failure?.kind).toBe('assertion');
    expect(result.failure?.stepIndex).toBe(stepIndex);
  });
});

describe('identity', () => {
  it('reaches the IR for a click on a row control whose label is shared', async () => {
    await writeFile(reproPaths('flow', root).ir, original);
    const repro = await readRepro('flow', root);
    // The demo flow deletes Sensor 2 through a "Delete" button on its row.
    const del = repro.steps.find((s) => s.action === 'click' && s.target?.semantic.includes('Delete'));
    expect(del?.target?.identity).toMatch(/Sensor 2/);
  });
});

