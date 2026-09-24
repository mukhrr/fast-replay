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
