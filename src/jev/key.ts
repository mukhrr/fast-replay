import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const NO_KEY_MESSAGE = '--goal needs a TypeSafe key: set TYPESAFE_API_KEY or run repro jev login';

// Outside the project on purpose: `repro init` commits .repros/config.json.
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'fast-replay');
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(configDir(env), 'credentials.json');
}

export function resolveKey(env: NodeJS.ProcessEnv = process.env): { key: string; source: 'env' | 'file' } | null {
  const fromEnv = env.TYPESAFE_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: 'env' };
  const file = credentialsPath(env);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let parsed: { typesafeApiKey?: unknown };
  try {
    parsed = JSON.parse(raw) as { typesafeApiKey?: unknown };
  } catch (err) {
    throw new Error(`${file}: not valid JSON (${(err as Error).message}). Run repro jev logout, then repro jev login.`);
  }
  const key = typeof parsed.typesafeApiKey === 'string' ? parsed.typesafeApiKey.trim() : '';
  return key ? { key, source: 'file' } : null;
}

export function saveKey(key: string, env: NodeJS.ProcessEnv = process.env): string {
  const file = credentialsPath(env);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ typesafeApiKey: key.trim() }, null, 2) + '\n', { mode: 0o600 });
  // writeFileSync's mode only applies when it creates the file.
  chmodSync(file, 0o600);
  return file;
}

export function deleteKey(env: NodeJS.ProcessEnv = process.env): boolean {
  const file = credentialsPath(env);
  try {
    readFileSync(file);
  } catch {
    return false;
  }
  rmSync(file);
  return true;
}
