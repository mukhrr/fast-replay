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
