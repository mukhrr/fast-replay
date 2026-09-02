import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { REPROS_DIR } from './ir/io.js';

/**
 * Project settings, committed alongside the shared steps.
 *
 * Deliberately one field. Repros are disposable and sessions hold tokens, so
 * this file is the only thing under .repros/ besides steps that a team shares,
 * and every field added here is a decision every project has to make.
 */
export const ConfigSchema = z.object({
  /** How many repros must share a prefix before the tool suggests extracting it. */
  extractThreshold: z.number().int().min(2).default(4),
});
export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: Config = ConfigSchema.parse({});
export const CONFIG_FILE = path.join(REPROS_DIR, 'config.json');

export async function loadConfig(root = process.cwd()): Promise<Config> {
  const file = path.join(root, CONFIG_FILE);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return DEFAULT_CONFIG;
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
