import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_FILE, DEFAULT_CONFIG } from './config.js';
import { STEPS_DIR } from './steps.js';

/**
 * The line through .repros/: repros, sessions, drive files and artifacts are
 * disposable and hold tokens; steps and config are the durable, shared part.
 * `.repros/*` with two exceptions is the only shape git accepts for that, since
 * a directory ignored as a whole cannot have a child re-included.
 */
export const GITIGNORE_BLOCK = [
  '# fast-replay: repros and sessions are disposable and hold tokens; steps and config are shared',
  '.repros/*',
  '!.repros/steps/',
  '!.repros/config.json',
];

/**
 * Ways of ignoring the directory itself. Appending the block below one of these
 * changes nothing: git never descends into an excluded directory, so
 * `!.repros/steps/` is inert and init would report a fix it did not make.
 */
const WHOLE_DIRECTORY_IGNORES = new Set(['.repros/', '.repros', '/.repros/', '/.repros']);

export interface InitReport {
  changes: string[];
  /** Set when .gitignore excludes .repros/ whole, which no appended rule can undo. */
  gitignoreConflict: { line: number } | null;
}

/** Idempotent. Every change made is named in the report; nothing else is touched. */
export async function initProject(root = process.cwd()): Promise<InitReport> {
  const changes: string[] = [];
  let gitignoreConflict: { line: number } | null = null;

  const ignoreFile = path.join(root, '.gitignore');
  let existing = '';
  try {
    existing = await readFile(ignoreFile, 'utf8');
  } catch {
    // No .gitignore yet; one is created below.
  }
  const lines = existing.split(/\r?\n/);
  const excluded = lines.findIndex((line) => {
    const rule = line.trim();
    return !rule.startsWith('#') && WHOLE_DIRECTORY_IGNORES.has(rule);
  });
  if (lines.includes('.repros/*')) {
    changes.push('.gitignore already ignores .repros/* (left unchanged)');
  } else if (excluded !== -1) {
    gitignoreConflict = { line: excluded + 1 };
    changes.push(
      `.gitignore line ${excluded + 1} ignores .repros/ as a whole, so steps and config cannot be committed; ` +
        'replace it with the block above',
    );
  } else {
    const glue = existing.length === 0 ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
    await writeFile(ignoreFile, `${existing}${glue}${GITIGNORE_BLOCK.join('\n')}\n`, 'utf8');
    changes.push(
      `.gitignore: added ${GITIGNORE_BLOCK.length - 1} rules (repros and sessions ignored, steps and config committed)`,
    );
  }

  const configFile = path.join(root, CONFIG_FILE);
  if (existsSync(configFile)) {
    changes.push(`${CONFIG_FILE} already exists (left unchanged)`);
  } else {
    await mkdir(path.dirname(configFile), { recursive: true });
    await writeFile(configFile, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, 'utf8');
    changes.push(`wrote ${CONFIG_FILE}`);
  }

  await mkdir(path.join(root, STEPS_DIR), { recursive: true });
  changes.push(`${STEPS_DIR}/ ready for shared steps`);

  return { changes, gitignoreConflict };
}
