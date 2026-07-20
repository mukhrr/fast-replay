import { randomUUID } from 'node:crypto';

/**
 * Placeholder expansion for recorded values, selectors and waits.
 *
 * Some repros are single-shot as recorded: the flow mutates server state, so
 * the second replay finds the work already done and the bug cannot recur. A
 * developer looping on `--expect-fixed` then gets green from run 2 onward
 * whether or not they fixed anything — a silent false pass, the worst outcome
 * this tool can produce.
 *
 * Client-side session seeding cannot help; the mutation is on the server. What
 * does help is making the input unique per run:
 *
 *   "value": "merchant:walmart-{{random}}"
 *
 * But a changed input invalidates everything downstream that embedded the old
 * one. Renaming a sensor to `Boiler-x7f2` breaks a recorded wait on
 * `role=button[name="Delete Boiler inlet"]`, because the accessible name was
 * derived from the value. So placeholders can be **named**, and a name expands
 * to the same string everywhere within a single run:
 *
 *   "value":       "Boiler-{{random:sensor}}"
 *   "domAppeared": ["role=button[name=\"Delete Boiler-{{random:sensor}}\"]"]
 *
 * Anonymous `{{random}}` still yields a fresh value at every occurrence, which
 * is what you want when nothing downstream refers to it.
 */

const GENERATORS: Record<string, () => string> = {
  uuid: () => randomUUID(),
  random: () => Math.random().toString(36).slice(2, 10),
  now: () => String(Date.now()),
  isodate: () => new Date().toISOString(),
};

export const PLACEHOLDER_NAMES = Object.keys(GENERATORS);

const PLACEHOLDER_RE = /\{\{(\w+)(?::(\w+))?\}\}/g;

export interface Expander {
  /** Null and plain strings pass through untouched. */
  expand<T extends string | null | undefined>(value: T): T;
  expandAll(values: string[] | undefined): string[] | undefined;
}

/**
 * One expander per replay. Named placeholders are memoized on it, so the same
 * name resolves identically across every step, selector and wait in that run —
 * and differently on the next run, which is the whole point.
 */
export function createExpander(): Expander {
  const memo = new Map<string, string>();

  function expandString(value: string): string {
    return value.replace(PLACEHOLDER_RE, (match, kind: string, name?: string) => {
      const make = GENERATORS[kind];
      // Unknown placeholders are left alone rather than blanked, so a typo is
      // visible in the failure message instead of silently emptying a field.
      if (!make) return match;
      if (!name) return make();
      const key = `${kind}:${name}`;
      let existing = memo.get(key);
      if (existing === undefined) {
        existing = make();
        memo.set(key, existing);
      }
      return existing;
    });
  }

  return {
    expand(value) {
      return (typeof value === 'string' ? expandString(value) : value) as typeof value;
    },
    expandAll(values) {
      return values?.map(expandString);
    },
  };
}

export function hasPlaceholder(value: string | null | undefined): boolean {
  if (!value) return false;
  PLACEHOLDER_RE.lastIndex = 0;
  return PLACEHOLDER_RE.test(value);
}
