import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseRepro, type Repro } from './schema.js';

export const REPROS_DIR = '.repros';

/** Filesystem layout for one repro, all derived from the project root. */
export interface ReproPaths {
  root: string;
  reprosDir: string;
  /** The IR itself: .repros/<name>.json */
  ir: string;
  /** Sidecar dir for everything that isn't the IR: .repros/<name>/ */
  dir: string;
  storageState: string;
  artifactsDir: string;
  lastResult: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Repro names become path segments, so reject anything that could escape the
 * .repros directory or collide with the sidecar-dir convention.
 */
export function assertValidName(name: string): void {
  if (!NAME_RE.test(name) || name.includes('..')) {
    throw new Error(
      `Invalid repro name "${name}". Use letters, digits, dot, dash and underscore; must start alphanumeric.`,
    );
  }
}

export function reproPaths(name: string, root = process.cwd()): ReproPaths {
  assertValidName(name);
  // Pointing at the repros directory itself is the obvious mistake to make,
  // and silently producing `.repros/.repros/` helps nobody.
  const base = path.basename(root) === REPROS_DIR ? path.dirname(root) : root;
  const reprosDir = path.join(base, REPROS_DIR);
  const dir = path.join(reprosDir, name);
  return {
    root: base,
    reprosDir,
    ir: path.join(reprosDir, `${name}.json`),
    dir,
    storageState: path.join(dir, 'state.json'),
    artifactsDir: path.join(dir, 'artifacts'),
    lastResult: path.join(dir, 'last-result.json'),
  };
}

/**
 * Write via a temp file in the destination directory then rename. A rename
 * within one filesystem is atomic, so a crashed or concurrent write can never
 * leave a half-parsed IR on disk — which matters because Phase 1's self-healer
 * rewrites selectors in place while a replay is running.
 */
export async function writeFileAtomic(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, contents, 'utf8');
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

export async function writeRepro(repro: Repro, paths: ReproPaths): Promise<void> {
  await writeFileAtomic(paths.ir, `${JSON.stringify(repro, null, 2)}\n`);
}

export async function readRepro(name: string, root = process.cwd()): Promise<Repro> {
  const paths = reproPaths(name, root);
  let raw: string;
  try {
    raw = await readFile(paths.ir, 'utf8');
  } catch {
    throw new Error(`No repro named "${name}". Looked for ${path.relative(root, paths.ir)}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Repro "${name}" is not valid JSON (${(err as Error).message}). File: ${path.relative(root, paths.ir)}`,
    );
  }
  return parseRepro(data, path.relative(root, paths.ir));
}

export interface LastResult {
  status: 'pass' | 'fail';
  at: string;
  durationMs: number;
  failedStepId?: string;
}

export async function writeLastResult(paths: ReproPaths, result: LastResult): Promise<void> {
  await writeFileAtomic(paths.lastResult, `${JSON.stringify(result, null, 2)}\n`);
}

export async function readLastResult(paths: ReproPaths): Promise<LastResult | null> {
  try {
    return JSON.parse(await readFile(paths.lastResult, 'utf8')) as LastResult;
  } catch {
    return null;
  }
}

export interface ReproSummary {
  name: string;
  createdAt: string | null;
  steps: number | null;
  lastResult: LastResult | null;
  /** Set when the IR exists but does not parse, so `list` never hard-fails. */
  error: string | null;
}

export async function listRepros(root = process.cwd()): Promise<ReproSummary[]> {
  const reprosDir = path.join(root, REPROS_DIR);
  let entries: string[];
  try {
    entries = await readdir(reprosDir);
  } catch {
    return [];
  }

  const names = entries.filter((e) => e.endsWith('.json')).map((e) => e.slice(0, -'.json'.length));

  const summaries = await Promise.all(
    names.map(async (name): Promise<ReproSummary> => {
      const paths = reproPaths(name, root);
      const lastResult = await readLastResult(paths);
      try {
        const repro = await readRepro(name, root);
        return {
          name,
          createdAt: repro.createdAt,
          steps: repro.steps.length,
          lastResult,
          error: null,
        };
      } catch (err) {
        return {
          name,
          createdAt: null,
          steps: null,
          lastResult,
          error: (err as Error).message.split('\n')[0] ?? 'unreadable',
        };
      }
    }),
  );

  return summaries.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

export async function deleteRepro(name: string, root = process.cwd()): Promise<boolean> {
  const paths = reproPaths(name, root);
  const existed = await stat(paths.ir).then(
    () => true,
    () => false,
  );
  await rm(paths.ir, { force: true });
  await rm(paths.dir, { recursive: true, force: true });
  return existed;
}
