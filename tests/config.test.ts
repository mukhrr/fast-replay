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
