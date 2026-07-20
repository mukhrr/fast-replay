import type { Locator, Page } from 'playwright';
import type { Target } from '../ir/schema.js';

export interface ResolveTimeouts {
  /** The recorded best guess deserves a real chance before we move on. */
  first: number;
  /** Fallbacks are cheap probes; a long timeout here just burns wall-clock. */
  subsequent: number;
}

export const DEFAULT_RESOLVE_TIMEOUTS: ResolveTimeouts = { first: 800, subsequent: 400 };

export interface Resolved {
  locator: Locator;
  selector: string;
  /** Index into target.candidates, so callers can report degraded resolution. */
  candidateIndex: number;
}

export class TargetResolutionError extends Error {
  constructor(
    readonly target: Target,
    readonly attempts: { selector: string; error: string }[],
  ) {
    super(`Could not find ${target.semantic}`);
    this.name = 'TargetResolutionError';
  }
}

/**
 * Try each recorded selector in priority order. Phase 0 deliberately does NOT
 * heal: exhausting the candidates is a hard failure, reported with the semantic
 * description so a human knows what the step meant.
 *
 * `onExhausted` is the seam Phase 1's LLM re-grounding plugs into — it may
 * return a replacement selector, and the caller patches the IR.
 */
export async function resolveTarget(
  page: Page,
  target: Target,
  timeouts: ResolveTimeouts = DEFAULT_RESOLVE_TIMEOUTS,
  onExhausted?: (target: Target, page: Page) => Promise<string | null>,
): Promise<Resolved> {
  const attempts: { selector: string; error: string }[] = [];

  for (let i = 0; i < target.candidates.length; i++) {
    const selector = target.candidates[i];
    if (!selector) continue;
    const timeout = i === 0 ? timeouts.first : timeouts.subsequent;
    try {
      const locator = page.locator(selector).first();
      await locator.waitFor({ state: 'visible', timeout });
      return { locator, selector, candidateIndex: i };
    } catch (err) {
      attempts.push({ selector, error: firstLine(err) });
    }
  }

  if (onExhausted) {
    const healed = await onExhausted(target, page);
    if (healed) {
      const locator = page.locator(healed).first();
      await locator.waitFor({ state: 'visible', timeout: timeouts.first });
      return { locator, selector: healed, candidateIndex: -1 };
    }
  }

  throw new TargetResolutionError(target, attempts);
}

function firstLine(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split('\n')[0] ?? msg;
}
