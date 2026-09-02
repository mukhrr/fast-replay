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

export interface InitReport {
  changes: string[];
}

/** Idempotent. Every change made is named in the report; nothing else is touched. */
export async function initProject(root = process.cwd()): Promise<InitReport> {
  const changes: string[] = [];

  const ignoreFile = path.join(root, '.gitignore');
  let existing = '';
  try {
    existing = await readFile(ignoreFile, 'utf8');
  } catch {
    // No .gitignore yet; one is created below.
  }
  if (existing.split(/\r?\n/).includes('.repros/*')) {
    changes.push('.gitignore already ignores .repros/* (left unchanged)');
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

  return { changes };
}
