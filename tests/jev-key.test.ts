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
