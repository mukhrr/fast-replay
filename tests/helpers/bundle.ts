import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
export const AGENT_DIR = path.resolve(here, '../../src/recorder/agent');

/**
 * Bundle a snippet of agent code for evaluation in a real page.
 *
 * The agent's own entry point deliberately exposes only the installer, so tests
 * build their own entry rather than widening the production surface for test
 * convenience.
 */
export async function bundleForPage(contents: string): Promise<string> {
  const result = await build({
    stdin: { contents, resolveDir: AGENT_DIR, sourcefile: 'test-entry.ts', loader: 'ts' },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    keepNames: false,
    write: false,
  });
  const output = result.outputFiles?.[0];
  if (!output) throw new Error('esbuild produced no output');
  return output.text;
}
