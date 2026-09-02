import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { REPROS_DIR } from './ir/io.js';

/**
 * Project settings, committed alongside the shared steps.
 *
 * Deliberately one field: everything else under .repros/ is disposable or
 * holds tokens, so every field added here is a decision every project has to make.
 */
export const ConfigSchema = z.object({
  /** How many repros must share a prefix before the tool suggests extracting it. */
  extractThreshold: z.number().int().min(2).default(4),
});
export type Config = z.infer<typeof ConfigSchema>;

/** Frozen: it is handed to callers and written to disk, and a mutation would travel. */
export const DEFAULT_CONFIG: Config = Object.freeze(ConfigSchema.parse({}));
export const CONFIG_FILE = path.join(REPROS_DIR, 'config.json');

export async function loadConfig(root = process.cwd()): Promise<Config> {
  const file = path.join(root, CONFIG_FILE);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    // Only a file that does not exist means "use the defaults". Anything else
    // silently turning into the defaults would hide a committed setting.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_CONFIG;
    throw new Error(`Could not read ${CONFIG_FILE}: ${(err as Error).message}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = ConfigSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid ${CONFIG_FILE}\n${issues}`);
  }
  return parsed.data;
}
