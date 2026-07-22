import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page } from 'playwright';

/**
 * Shared setup steps.
 *
 * Almost every bug sits behind the same few preambles — sign in, open a
 * workspace, get to a chat. Re-deriving them per repro is the single largest
 * cost in authoring one, and re-*recording* them is worse: a recorded preamble
 * is a second artifact that rots, and when the login page changes it breaks
 * every repro at once for a reason unrelated to any of their bugs.
 *
 * A shared step is a function, so it is readable, diffable and reviewable like
 * the rest of your code. What this module adds is the two things a plain
 * function cannot provide:
 *
 *   - **discovery** — an agent starting fresh has no idea what already exists,
 *     and will happily write a fourth sign-in helper. `repro steps` and the
 *     `repro_steps` tool answer that.
 *   - **a contract** — `ensures` is checked automatically after the step runs,
 *     so a broken preamble reports itself once, precisely, instead of surfacing
 *     as a dozen repros failing somewhere further along.
 *
 * Deliberately not included: matching an issue's prose to a step. That is a
 * judgement, and this tool does not call models — deciding *which* step to use
 * belongs to the agent reading the issue, which already has the context.
 */

export interface StepDefinition {
  /** Stable identifier, used to invoke it. */
  name: string;
  /** What state this leaves you in. Written for whoever is choosing between steps. */
  description: string;
  /** Names of steps that must run first. Enforced, not documentation. */
  requires?: string[];
  /**
   * A selector that must be present once this has run.
   *
   * Checked automatically. Without it a broken preamble fails silently and the
   * repro that used it fails later, somewhere unrelated.
   */
  ensures?: string;
  /** How long to wait for `ensures`. Preambles are usually the slow part. */
  ensuresTimeoutMs?: number;
  /**
   * Values this step accepts, with their defaults.
   *
   * The common case should need none: `step('signed-in')` uses the stored
   * account. Pass one only where a bug genuinely differs — signing up fresh,
   * a particular plan, a specific merchant.
   */
  defaults?: Record<string, string>;
  run(page: Page, params: Record<string, string>): Promise<void>;
}

export interface LoadedStep extends StepDefinition {
  /** Where it came from, so a broken one can be found. */
  file: string;
}

/** Identity function that exists to give the definition a type. */
export function defineStep(definition: StepDefinition): StepDefinition {
  return definition;
}

export const STEPS_DIR = path.join('.repros', 'steps');

/**
 * Load every step in a directory.
 *
 * A file that fails to import is reported rather than thrown: one broken step
 * should not make the others undiscoverable, which is exactly when you need to
 * see the list.
 */
export async function loadSteps(
  dir: string,
): Promise<{ steps: Map<string, LoadedStep>; errors: { file: string; message: string }[] }> {
  const steps = new Map<string, LoadedStep>();
  const errors: { file: string; message: string }[] = [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { steps, errors };
  }

  for (const entry of entries.sort()) {
    if (!/\.(m?js|ts)$/.test(entry) || entry.endsWith('.d.ts')) continue;
    const file = path.join(dir, entry);
    try {
      const mod = (await import(pathToFileURL(path.resolve(file)).href)) as {
        default?: StepDefinition;
      };
      const definition = mod.default;
      if (!definition?.name || typeof definition.run !== 'function') {
        errors.push({ file, message: 'no default export from defineStep()' });
        continue;
      }
      steps.set(definition.name, { ...definition, file });
    } catch (err) {
      errors.push({ file, message: (err as Error).message.split('\n')[0] ?? 'failed to import' });
    }
  }

  return { steps, errors };
}

export class StepError extends Error {
  constructor(
    readonly step: string,
    reason: string,
  ) {
    super(`Shared step "${step}" ${reason}`);
    this.name = 'StepError';
  }
}

/**
 * Run a step and confirm it did what it promised.
 *
 * Order matters: `requires` runs first, then the step, then `ensures`. A
 * preamble that half-worked is the worst outcome — the repro proceeds from a
 * state nobody described and fails somewhere that looks like the bug.
 */
export async function runStep(
  name: string,
  page: Page,
  steps: Map<string, LoadedStep>,
  alreadyRun = new Set<string>(),
  params: Record<string, string> = {},
): Promise<void> {
  if (alreadyRun.has(name)) return;
  const step = steps.get(name);
  if (!step) {
    const known = Array.from(steps.keys());
    throw new StepError(
      name,
      known.length ? `is not defined. Available: ${known.join(', ')}` : 'is not defined.',
    );
  }

  alreadyRun.add(name);
  for (const dependency of step.requires ?? []) {
    await runStep(dependency, page, steps, alreadyRun);
  }

  await step.run(page, { ...step.defaults, ...params });

  if (step.ensures) {
    try {
      await page
        .locator(step.ensures)
        .first()
        .waitFor({ state: 'visible', timeout: step.ensuresTimeoutMs ?? 30_000 });
    } catch {
      throw new StepError(
        name,
        `ran but did not reach the state it promises.\n` +
          `      Expected: ${step.ensures}\n` +
          `      Defined in: ${step.file}\n` +
          `      Fix the step once and every repro that uses it is fixed.`,
      );
    }
  }
}
