import { describe, expect, it } from 'vitest';
import { deriveAssertion } from '../src/compiler/compile.js';
import { checkBugRecurred } from '../src/replayer/invariants.js';
import { isStableClass } from '../src/recorder/agent/text.js';
import type { Repro } from '../src/ir/schema.js';
import type { RawActionEvent, RecordingTrace } from '../src/recorder/types.js';

/**
 * Regressions found the first time this tool met a real codebase (Expensify).
 * Every one of these passed on the demo app and failed in production.
 */

const BASE = 'http://localhost:3000';

function trace(over: Partial<RecordingTrace> = {}): RecordingTrace {
  return {
    actions: [],
    dom: [],
    navigations: [],
    network: [],
    console: [],
    startedAt: 0,
    endedAt: 10_000,
    baseUrl: BASE,
    startPath: '/',
    viewport: { width: 1440, height: 900 },
    ...over,
  };
}

const action = (t: number): RawActionEvent => ({
  kind: 'action',
  action: 'click',
  value: null,
  target: { candidates: ['[data-testid="x"]'], semantic: 'x' },
  author: 'human',
  t,
});

describe('React Native Web atomic class hashes', () => {
  it('rejects them, so they never reach a CSS path', () => {
    // These change whenever styling changes. `r-1awozwy` previously passed as
    // stable because it has fewer than three digits.
    for (const c of ['r-1awozwy', 'r-1mdbw0j', 'r-13qz1uu', 'r-1e084wir']) {
      expect(isStableClass(c), `${c} must be rejected`).toBe(false);
    }
  });

  it('still keeps ordinary utility classes', () => {
    for (const c of ['sensor-row', 'btn-primary', 'col-2', 'mt-4', 'nav_link']) {
      expect(isStableClass(c), `${c} must be kept`).toBe(true);
    }
  });
});

describe('bug signature vs ambient console noise', () => {
  const ambient = [
    "Access to fetch at 'https://x/api/fl' has been blocked by CORS policy",
    'GET https://cdn.example.com/a.js net::ERR_NAME_NOT_RESOLVED',
    'Failed to load resource: the server responded with a status of 404',
    'Download the React DevTools for a better development experience',
  ];

  it('keeps environment noise out of the recorded bug signature', () => {
    const assertion = deriveAssertion(
      [],
      trace({
        actions: [action(1_000)],
        console: ambient.map((text, i) => ({ kind: 'console' as const, text, t: 2_000 + i })),
      }),
    );
    // Otherwise --expect-fixed reports "bug still present" forever, and an
    // agent keeps editing code that was already correct.
    expect(assertion.observedAtRecord?.consoleErrors).toEqual([]);
    expect(assertion.invariants.noConsoleErrors).toBe(true);
  });

  it('ignores anything logged before the first action', () => {
    const assertion = deriveAssertion(
      [],
      trace({
        actions: [action(5_000)],
        console: [{ kind: 'console', text: 'TypeError: boot noise', t: 1_000 }],
      }),
    );
    // Boot-time errors recur on every run regardless of the flow, so they are
    // useless as a signature for this particular bug.
    expect(assertion.observedAtRecord?.consoleErrors).toEqual([]);
  });

  it('still captures a real error caused by the flow', () => {
    const assertion = deriveAssertion(
      [],
      trace({
        actions: [action(1_000)],
        console: [
          { kind: 'console', text: 'TypeError: cannot read id of undefined', t: 2_000 },
          { kind: 'console', text: ambient[0]!, t: 2_100 },
        ],
      }),
    );
    expect(assertion.observedAtRecord?.consoleErrors).toEqual([
      'TypeError: cannot read id of undefined',
    ]);
    expect(assertion.invariants.noConsoleErrors).toBe(false);
  });

  it('does not report a recurrence from ambient noise alone', () => {
    const repro = {
      assertion: {
        observedAtRecord: { consoleErrors: [], failedRequests: [] },
      },
      steps: [],
    } as unknown as Repro;

    const recurred = checkBugRecurred(
      repro,
      [],
      ambient.map((text, i) => ({ kind: 'console' as const, text, t: i })),
      BASE,
    );
    expect(recurred).toEqual([]);
  });
});
