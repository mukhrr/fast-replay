import { matchesUrlPattern } from '../compiler/normalize.js';
import type { NetworkWait, Repro } from '../ir/schema.js';
import type { RawConsoleEvent, RawNetworkEvent } from '../recorder/types.js';

/**
 * Every endpoint the recording actually exercised. Failed-request checking is
 * scoped to these: a third-party analytics beacon 404-ing is noise, and letting
 * it fail a repro would make the tool untrustworthy within a day.
 */
export function recordedPatterns(repro: Repro): NetworkWait[] {
  const all: NetworkWait[] = [];
  for (const step of repro.steps) all.push(...(step.waitAfter.network ?? []));
  all.push(...(repro.assertion.finalState.network ?? []));
  for (const f of repro.assertion.observedAtRecord?.failedRequests ?? []) {
    all.push({ urlPattern: f.urlPattern, method: f.method });
  }
  const seen = new Set<string>();
  return all.filter((n) => {
    const key = `${n.method} ${n.urlPattern}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface InvariantViolation {
  invariant: 'noConsoleErrors' | 'noFailedRequests';
  detail: string;
}

export function checkInvariants(
  repro: Repro,
  network: RawNetworkEvent[],
  consoleErrors: RawConsoleEvent[],
  baseUrl: string,
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  if (repro.assertion.invariants.noConsoleErrors) {
    for (const err of consoleErrors) {
      violations.push({ invariant: 'noConsoleErrors', detail: err.text });
    }
  }

  if (repro.assertion.invariants.noFailedRequests) {
    const patterns = recordedPatterns(repro);
    for (const n of network) {
      if (!n.failed) continue;
      const inScope = patterns.some(
        (p) =>
          p.method.toUpperCase() === n.method.toUpperCase() &&
          matchesUrlPattern(n.url, p.urlPattern, baseUrl),
      );
      if (!inScope) continue;
      violations.push({
        invariant: 'noFailedRequests',
        detail: `${n.method} ${n.url} -> ${n.status ?? 'aborted'}`,
      });
    }
  }

  return violations;
}
