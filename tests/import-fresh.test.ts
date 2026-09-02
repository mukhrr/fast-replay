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
