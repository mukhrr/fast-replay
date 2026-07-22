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

/**
 * The selector resolved, but to something that is not what was recorded.
 *
 * Distinct from "nothing matched": the app is reachable and the flow could
 * continue, but continuing would act on the wrong record and produce a verdict
 * about a bug that was never exercised.
 */
export class IdentityMismatchError extends Error {
  constructor(
    readonly target: Target,
    readonly selector: string,
    readonly found: string,
  ) {
    super(
      `Selector ${selector} matched an element that is not "${target.identity}".\n` +
        `      Expected to act on: ${target.semantic}\n` +
        `      Actually found:     ${found || '(no text)'}\n` +
        `      Acting on it would produce a verdict about the wrong record.`,
    );
    this.name = 'IdentityMismatchError';
  }
}

/**
 * Normalised, forgiving comparison.
 *
 * Either side containing the other counts: a row's text includes the name plus
 * whatever else the row renders, and an accessible name is often a fragment of
 * the visible label. Requiring equality would refuse constantly.
 */
export function identityMatches(found: string, identity: string): boolean {
  const norm = (v: string) => v.replace(/\s+/g, ' ').trim().toLowerCase();
  const a = norm(found);
  const b = norm(identity);
  if (!a || !b) return true;
  return a.includes(b) || b.includes(a);
}

/**
 * Identities too weak to judge by.
 *
 * A bare number or a one-word label appears all over a page, so a mismatch
 * would say nothing — and a check that refuses on noise gets switched off.
 */
export function isCheckableIdentity(identity: string | undefined): identity is string {
  if (!identity) return false;
  const trimmed = identity.trim();
  return trimmed.length >= 4 && /[a-z]/i.test(trimmed);
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
