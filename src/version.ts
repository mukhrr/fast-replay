import { createRequire } from 'node:module';

/**
 * Single source of truth for the version, read from the manifest.
 *
 * Two builds both reporting 0.1.0 made them indistinguishable in the field —
 * the only way to tell them apart was grepping dist/ for a feature string.
 */
const require = createRequire(import.meta.url);
export const VERSION: string = (require('../package.json') as { version: string }).version;
