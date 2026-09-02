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
