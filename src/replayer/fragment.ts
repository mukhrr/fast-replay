import type { Page } from 'playwright';
import { z } from 'zod';
import { StepSchema, type Step } from '../ir/schema.js';
import { collectReactions } from '../recorder/reaction.js';
import { performStep } from './perform.js';
import { createExpander } from './values.js';
import { waitForReaction } from './waits.js';

/**
 * Replay a sequence of IR steps inside a shared setup step.
 *
 * This is what a step extracted by `repro extract` calls. Generating Playwright
 * code instead would drop the candidate ladder, the identity check and the
 * recorded waits — the exact machinery that makes replay trustworthy — so the
 * fragment goes through the same `performStep`/`waitForReaction` path a repro's
 * own steps do. A failure throws with the step named, which surfaces through
 * the ordinary shared-step reporting as COULD NOT VERIFY, never as a verdict
 * on the bug.
 */
export interface ReplayFragmentOptions {
  /**
   * Origin to rebase `goto` steps onto. Defaults to the origin the page is
   * currently on, so a fragment recorded against staging follows the run when
   * it is retargeted with `--env`.
   */
  baseUrl?: string;
  /** Multiply every recorded wait, mirroring `RunOptions.timeoutScale`. */
  timeoutScale?: number;
}

export async function replayFragment(
  page: Page,
  steps: unknown,
  options: ReplayFragmentOptions = {},
): Promise<void> {
  // Generated step files are meant to be hand-edited, so the fragment is
  // validated like any other IR rather than trusted.
  const parsed: Step[] = z.array(StepSchema).parse(steps);
  const baseUrl = options.baseUrl ?? originOf(page);
  const expand = createExpander();
  const reactions = collectReactions(page.context());
  try {
    for (const step of parsed) {
      const since = Date.now();
      const semantic = step.target?.semantic ?? step.action;
      try {
        await performStep(page, step, baseUrl, {}, expand);
      } catch (err) {
        throw new Error(`fragment step ${step.id} (${semantic}): ${(err as Error).message}`);
      }
      const outcome = await waitForReaction(
        { page, baseUrl, network: reactions.network, since },
        {
          ...step.waitAfter,
          timeoutMs: Math.round(step.waitAfter.timeoutMs * (options.timeoutScale ?? 1)),
          domAppeared: expand.expandAll(step.waitAfter.domAppeared),
          domGone: expand.expandAll(step.waitAfter.domGone),
        },
      );
      if (!outcome.ok) {
        throw new Error(
          `fragment step ${step.id} (${semantic}): recorded signals never arrived within ` +
            `${step.waitAfter.timeoutMs}ms — ${outcome.unmet.join('; ')}`,
        );
      }
    }
  } finally {
    // Listeners are per-invocation; the page may be a warm session's.
    reactions.detach();
  }
}

function originOf(page: Page): string {
  try {
    const origin = new URL(page.url()).origin;
    return origin === 'null' ? page.url() : origin;
  } catch {
    return page.url();
  }
}
