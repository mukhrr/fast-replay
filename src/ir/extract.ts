import { normalizeUrlPattern } from '../compiler/normalize.js';
import { renumberSteps, type EditResult } from './edit.js';
import type { Repro, Step } from './schema.js';

/**
 * Finding the preamble that repros share, so it can become one shared step.
 *
 * Every issue against the same app tends to open with the same walk — sign in,
 * open the workspace, reach the screen. Each new recording re-drives it, and
 * each copy rots separately. This module finds recorded step sequences that
 * repeat across repros and rewrites the repros to reference one extracted step
 * instead.
 *
 * Everything here is structural: steps match on what they do (action, target,
 * value with volatile identifiers masked), never on prose. And nothing here
 * writes — detection reports candidates, and the rewrite happens only when a
 * caller applies one by name. Matching an issue to a step, and naming the
 * step, are judgements that stay with the caller.
 */

/**
 * Identifier-shaped substrings that vary between recordings of the same flow —
 * the substring counterparts of the compiler's per-segment volatile patterns.
 * Masking is only ever used to GROUP candidates; applying a rewrite demands
 * raw equality, so an over-eager mask can at worst suggest, never corrupt.
 */
const VOLATILE_SUBSTRING = [
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, // uuid
  /[0-9a-f]{12,}/gi, // hex blob
  /\d+/g, // digit run
];

function mask(text: string): string {
  let out = text;
  for (const re of VOLATILE_SUBSTRING) out = out.replace(re, '*');
  return out;
}

/**
 * What a step *does*, as a comparison key.
 *
 * `semantic` is prose and never part of it; `waitAfter` is timing, not
 * identity; `id` is positional. `goto` values normalize the way network
 * patterns do, so the same path recorded against two dev-server ports still
 * matches.
 */
export function stepKey(step: Step, baseUrl: string): string {
  const value =
    step.action === 'goto' && step.value
      ? normalizeUrlPattern(step.value, baseUrl)
      : mask(step.value ?? '');
  return JSON.stringify({
    action: step.action,
    candidate: mask(step.target?.candidates[0] ?? ''),
    identity: mask(step.target?.identity ?? ''),
    value,
  });
}

/** Raw comparison, used to gate an actual rewrite. Timing fields excluded. */
function rawEqual(a: Step, b: Step, aBase: string, bBase: string): boolean {
  if (a.action !== b.action) return false;
  const av = a.action === 'goto' ? normalizeUrlPattern(a.value ?? '', aBase) : (a.value ?? '');
  const bv = b.action === 'goto' ? normalizeUrlPattern(b.value ?? '', bBase) : (b.value ?? '');
  if (av !== bv) return false;
  if ((a.target?.candidates[0] ?? '') !== (b.target?.candidates[0] ?? '')) return false;
  return (a.target?.identity ?? '') === (b.target?.identity ?? '');
}

export interface PrefixCandidate {
  /** Step keys of the shared prefix, for matching against existing fragments. */
  keys: string[];
  /** Where the shared walk starts; repros with a different startPath never group. */
  startPath: string;
  /** Origin of the exemplar the fragment was cloned from. */
  baseUrl: string;
  /**
   * The fragment, cloned from the first member by name. Ids renumbered from
   * s1; each step's timeout is the max observed across members, so the slowest
   * recording sets the budget.
   */
  steps: Step[];
  /**
   * `exact: false` means the repro matched only after masking — same shape,
   * different identifiers — and must be converted by hand, never auto-applied.
   */
  repros: { name: string; exact: boolean }[];
}

export interface FindCommonPrefixOptions {
  /** Shortest prefix worth extracting. One step is not a preamble. */
  minSteps?: number;
  /** How many repros must share it before it counts as a pattern. */
  minRepros?: number;
}

/**
 * Every maximal recorded-step prefix shared by enough repros.
 *
 * Only prefixes: `setup` replays before recorded steps, so nothing but a true
 * prefix can legally move there. A shorter prefix shared by more repros and a
 * longer one shared by fewer are both reported; a prefix is dropped only when
 * a longer one covers exactly the same repros.
 */
export function findCommonPrefixes(
  repros: { name: string; repro: Repro }[],
  options: FindCommonPrefixOptions = {},
): PrefixCandidate[] {
  const minSteps = options.minSteps ?? 2;
  const minRepros = options.minRepros ?? 2;

  const chains = repros
    .map(({ name, repro }) => ({
      name,
      repro,
      keys: repro.steps.map((s) => stepKey(s, repro.baseUrl)),
    }))
    // Deterministic exemplar: first member by name.
    .sort((a, b) => a.name.localeCompare(b.name));

  const groups = new Map<string, typeof chains>();
  for (const chain of chains) {
    for (let len = minSteps; len <= chain.keys.length; len++) {
      const key = JSON.stringify([chain.repro.startPath, ...chain.keys.slice(0, len)]);
      const list = groups.get(key);
      if (list) list.push(chain);
      else groups.set(key, [chain]);
    }
  }

  const candidates = Array.from(groups.entries())
    .filter(([, members]) => members.length >= minRepros)
    .map(([key, members]) => ({
      key,
      parts: JSON.parse(key) as string[],
      members,
      names: members.map((m) => m.name).join('\n'),
    }));

  const extendsBy = (longer: string[], shorter: string[]): boolean =>
    longer.length > shorter.length && shorter.every((part, i) => longer[i] === part);

  const maximal = candidates.filter(
    (c) => !candidates.some((o) => o.names === c.names && extendsBy(o.parts, c.parts)),
  );

  return maximal
    .sort(
      (a, b) =>
        b.members.length - a.members.length ||
        b.parts.length - a.parts.length ||
        a.key.localeCompare(b.key),
    )
    .map(({ parts, members }) => {
      const len = parts.length - 1;
      const exemplar = members[0]!;
      const steps = JSON.parse(JSON.stringify(exemplar.repro.steps.slice(0, len))) as Step[];
      steps.forEach((step, i) => {
        step.id = `s${i + 1}`;
        step.waitAfter.timeoutMs = Math.max(
          ...members.map((m) => m.repro.steps[i]!.waitAfter.timeoutMs),
        );
      });
      return {
        keys: parts.slice(1),
        startPath: exemplar.repro.startPath,
        baseUrl: exemplar.repro.baseUrl,
        steps,
        repros: members.map((m) => ({
          name: m.name,
          exact: steps.every((f, i) =>
            rawEqual(f, m.repro.steps[i]!, exemplar.repro.baseUrl, m.repro.baseUrl),
          ),
        })),
      };
    });
}

export interface ExtractApplyResult extends EditResult {
  applied: boolean;
  /** Set when skipped: why this repro was left untouched. */
  reason?: string;
}

/**
 * Replace a repro's recorded prefix with a reference to a shared step.
 *
 * Re-verifies the prefix — including raw values — against the repro as it is
 * NOW, not as it was when suggested, and refuses with a reason rather than
 * rewriting on drift. Never writes; the caller decides what to do with the
 * returned repro.
 */
export function applyExtraction(
  input: Repro,
  fragment: Step[],
  stepName: string,
  options: { fragmentBaseUrl?: string } = {},
): ExtractApplyResult {
  const skip = (reason: string): ExtractApplyResult => ({
    repro: input,
    changes: [],
    applied: false,
    reason,
  });

  if (input.setup.some((entry) => entry.step === stepName)) {
    return skip(`already references shared step "${stepName}"`);
  }
  if (!fragment.length) return skip('empty fragment');
  if (fragment.length >= input.steps.length) {
    // The recorded steps past the preamble are where the bug lives; a repro
    // reduced to nothing but setup asserts nothing worth keeping.
    return skip('the prefix is the whole repro — keep at least one recorded step');
  }
  const fragmentBase = options.fragmentBaseUrl ?? input.baseUrl;
  for (let i = 0; i < fragment.length; i++) {
    if (!rawEqual(fragment[i]!, input.steps[i]!, fragmentBase, input.baseUrl)) {
      const same = stepKey(fragment[i]!, fragmentBase) === stepKey(input.steps[i]!, input.baseUrl);
      return skip(
        same
          ? `step ${input.steps[i]!.id} matches only after masking — values differ, parameterize by hand`
          : `step ${input.steps[i]!.id} no longer matches the fragment — the repro changed since it was suggested`,
      );
    }
  }

  const repro = JSON.parse(JSON.stringify(input)) as Repro;
  const moved = repro.steps.slice(0, fragment.length).map((s) => s.id);
  repro.steps = repro.steps.slice(fragment.length);
  // Appended after existing entries: the moved steps were recorded after any
  // setup this repro already had, so replay order is preserved.
  repro.setup = [...repro.setup, { step: stepName }];
  renumberSteps(repro);

  return {
    repro,
    changes: [
      `moved ${moved.length} step(s) (${moved[0]}–${moved[moved.length - 1]}) into shared step "${stepName}"`,
      'renumbered step ids to match position',
    ],
    applied: true,
  };
}
