import type { Page } from 'playwright';
import type { Step, Target } from '../ir/schema.js';
import {
  DEFAULT_RESOLVE_TIMEOUTS,
  identityMatches,
  IdentityMismatchError,
  isCheckableIdentity,
  resolveTarget,
  type ResolveTimeouts,
} from './resolve.js';
import type { Expander } from './values.js';

/**
 * Executing one IR step — the piece of replay that turns a recorded step into
 * a real browser action, with the candidate ladder and the identity check
 * intact. Lives apart from the run driver so a shared step extracted from
 * recordings can replay its fragment through the same machinery.
 */

export interface PerformOptions {
  resolveTimeouts?: ResolveTimeouts;
  /**
   * Called when every selector candidate for a step failed. Returning a
   * selector lets replay continue.
   */
  onStepFailure?: (target: Target, page: Page) => Promise<string | null>;
}

/** Performs one step; returns which candidate selector worked (-1 when targetless). */
export async function performStep(
  page: Page,
  step: Step,
  baseUrl: string,
  options: PerformOptions,
  expand: Expander,
): Promise<number> {
  // Derived from what this step actually measured, not from a constant. A flat
  // 800ms is wrong by more than an order of magnitude on a heavy app, and
  // guessing the first budget contradicts the rule every other wait follows.
  const timeouts = options.resolveTimeouts ?? deriveResolveTimeouts(step);

  if (step.action === 'goto') {
    await page.goto(rebase(step.value, baseUrl), { waitUntil: 'domcontentloaded' });
    return -1;
  }

  if (step.action === 'scroll' && !step.target) {
    const { x, y } = parsePosition(step.value);
    await page.evaluate(([px, py]) => window.scrollTo(px as number, py as number), [x, y]);
    return -1;
  }

  if (step.action === 'offline') {
    await page.context().setOffline(step.value === 'true');
    return -1;
  }

  if (step.action === 'press' && !step.target) {
    await page.keyboard.press(step.value ?? 'Enter');
    return -1;
  }

  if (!step.target) throw new Error(`Step ${step.id} (${step.action}) has no target to act on.`);

  const target = {
    ...step.target,
    candidates: expand.expandAll(step.target.candidates) ?? step.target.candidates,
  };
  const resolved = await resolveTarget(page, target, timeouts, options.onStepFailure);
  const { locator } = resolved;

  // Confirm the element we found is the one that was recorded, before doing
  // anything to it. A selector that drifts onto a neighbouring row still
  // resolves, still clicks, and still produces a well-formed verdict — about
  // the wrong record.
  const identity = expand.expand(target.identity);
  if (isCheckableIdentity(identity)) {
    // The control's own label and the row it sits in, together. A "Remove"
    // button reads the same on every row, so its own text can neither confirm
    // nor deny which record it belongs to — only the row can. Checking just one
    // of the two would refuse on every correct list row.
    const found = await locator
      .evaluate((el) => {
        const self = (el as HTMLElement).innerText || el.textContent || '';
        const row = el.closest(
          'tr, [role="row"], li, [role="listitem"], [data-testid*="row"], [data-testid*="Row"]',
        );
        const context = row && row !== el ? ((row as HTMLElement).innerText ?? '') : '';
        return `${self} ${context}`;
      })
      .catch(() => '');
    if (!identityMatches(found, identity)) {
      throw new IdentityMismatchError(target, resolved.selector, found.replace(/\s+/g, ' ').trim());
    }
  }

  switch (step.action) {
    case 'click':
      await locator.click();
      break;
    case 'rightclick':
      await locator.click({ button: 'right' });
      break;
    case 'dblclick':
      await locator.dblclick();
      break;
    case 'hover':
      await locator.hover();
      break;
    case 'fill':
      await locator.fill(expand.expand(step.value) ?? '');
      break;
    case 'select':
      await locator.selectOption(expand.expand(step.value) ?? '');
      break;
    case 'press':
      await locator.press(step.value ?? 'Enter');
      break;
    case 'scroll': {
      const { x, y } = parsePosition(step.value);
      await locator.evaluate((el, [px, py]) => {
        el.scrollLeft = px as number;
        el.scrollTop = py as number;
      }, [x, y]);
      break;
    }
    default:
      throw new Error(`Unsupported action "${step.action}" in step ${step.id}.`);
  }

  return resolved.candidateIndex;
}

/**
 * A selector budget proportional to how slowly this app was observed to react.
 *
 * A quarter of the step's own wait: long enough for a heavy app to render the
 * control, short enough that a genuinely missing element fails fast instead of
 * burning the whole budget on the first of five candidates.
 */
export function deriveResolveTimeouts(step: Step): ResolveTimeouts {
  const first = Math.min(
    15_000,
    Math.max(DEFAULT_RESOLVE_TIMEOUTS.first, Math.round(step.waitAfter.timeoutMs / 4)),
  );
  return { first, subsequent: Math.max(DEFAULT_RESOLVE_TIMEOUTS.subsequent, Math.round(first / 2)) };
}

/** Re-point a recorded absolute URL at the base URL replay is actually using. */
export function rebase(recorded: string | null, baseUrl: string): string {
  if (!recorded) return baseUrl;
  try {
    const u = new URL(recorded);
    return new URL(`${u.pathname}${u.search}${u.hash}`, baseUrl).toString();
  } catch {
    return new URL(recorded, baseUrl).toString();
  }
}

function parsePosition(value: string | null): { x: number; y: number } {
  try {
    const parsed = JSON.parse(value ?? '{}') as { x?: number; y?: number };
    return { x: parsed.x ?? 0, y: parsed.y ?? 0 };
  } catch {
    return { x: 0, y: 0 };
  }
}
