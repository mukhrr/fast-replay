import type { Page } from 'playwright';
import { importFresh } from './import-fresh.js';
import type { DriveApi } from './recorder/launch.js';

/**
 * A recording an agent hands to the tool as a file.
 *
 * The agent already has the locators from exploring the bug; a drive file is
 * where they go. `setup` is declared rather than invoked so the session step
 * can be seeded from the project's stored session before the browser opens.
 */
export interface DriveDefinition {
  /** Shared setup run before `drive`, by name. A session step here is seeded, not re-run. */
  setup?: { step: string; params?: Record<string, string> }[];
  drive(page: Page, api: DriveApi): Promise<void>;
}

/** Identity function that exists to give the definition a type. */
export function defineDrive(definition: DriveDefinition): DriveDefinition {
  return definition;
}

/** Import a drive file, seeing edits made since the last import, and check its shape. */
export async function loadDrive(file: string): Promise<DriveDefinition> {
  let mod: { default?: unknown };
  try {
    mod = await importFresh<{ default?: unknown }>(file);
  } catch (err) {
    throw new Error(`Could not load drive file ${file}: ${(err as Error).message.split('\n')[0]}`);
  }
  const def = mod.default as Partial<DriveDefinition> | undefined;
  if (typeof def?.drive !== 'function') {
    throw new Error(`${file}: no default export from defineDrive()`);
  }
  return def as DriveDefinition;
}
