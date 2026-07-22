import {
  IR_VERSION,
  type Action,
  type Assertion,
  type FinalState,
  type Repro,
  type Step,
} from '../ir/schema.js';
import type { RawActionEvent, RawNetworkEvent, RecordingTrace } from '../recorder/types.js';
import { isAmbientConsoleError, isIncidentalRequest } from '../noise.js';
import { isSameOrigin, normalizeUrlPattern } from './normalize.js';
import { buildWaitAfter, DEFAULT_WAIT_RULES, type WaitRules } from './waits.js';

export interface CompileOptions {
  name: string;
  storageStatePath: string | null;
  /** Evidence the driver declared, which outranks anything derived. */
  observed?: { selector: string; absent: boolean }[];
  createdAt?: string;
  waitRules?: WaitRules;
}

/** A click and a dblclick on the same element this close together are one gesture. */
const DBLCLICK_MERGE_MS = 600;

/**
 * Keyboard activation and the click a framework synthesises from it are one
 * gesture. React Native Web turns Enter/Space on a button into a click, so both
 * were recorded; on replay the second one fires after the first already opened
 * a modal, and gets intercepted by the overlay.
 */
const KEY_ACTIVATION_MS = 150;
const ACTIVATION_KEYS = ['Enter', 'Space', ' '];
/**
 * A navigation this soon after an action is that action's consequence.
 *
 * Generous on purpose: on a production app a click can take seconds to settle
 * into a route change, and mis-attributing that produced a `goto` step for the
 * page the user was already on.
 */
const NAV_ATTRIBUTION_MS = 5_000;

/**
 * Actions that can plausibly navigate.
 *
 * A scroll or a hover cannot, so treating one as the cause of a page load both
 * loses the navigation as a step and — worse — leaves the load's DOM signals
 * attributed to it.
 */
const CAN_NAVIGATE: readonly Action[] = ['click', 'rightclick', 'dblclick', 'press', 'select'];

/** How long after a navigation a document load still counts as the same event. */
const DOCUMENT_LOAD_MS = 3_000;

type Pending = RawActionEvent & { syntheticUrl?: string };

/**
 * Drop the two clicks that the browser necessarily fires before a dblclick.
 * Replaying click-click-dblclick would triple-fire the handler.
 */
function mergeDoubleClicks(actions: RawActionEvent[]): RawActionEvent[] {
  const out: RawActionEvent[] = [];
  for (const action of actions) {
    if (action.action === 'dblclick') {
      const key = action.target?.candidates[0];
      while (out.length) {
        const prev = out[out.length - 1];
        if (!prev) break;
        const sameTarget = prev.target?.candidates[0] === key;
        if (prev.action === 'click' && sameTarget && action.t - prev.t <= DBLCLICK_MERGE_MS) {
          out.pop();
          continue;
        }
        break;
      }
    }
    out.push(action);
  }
  return out;
}

/**
 * Some environments deliver a plain click alongside a right-click. Replaying
 * both opens the context menu and then dismisses it.
 */
function dropClickBeforeRightClick(actions: RawActionEvent[]): RawActionEvent[] {
  return actions.filter((action, i) => {
    if (action.action !== 'click') return true;
    const next = actions[i + 1];
    if (!next || next.action !== 'rightclick') return true;
    if (next.t - action.t > KEY_ACTIVATION_MS) return true;
    return next.target?.candidates[0] !== action.target?.candidates[0];
  });
}

/** Drop the click a framework synthesises from a keyboard activation. */
function dropSynthesizedActivation(actions: RawActionEvent[]): RawActionEvent[] {
  return actions.filter((action, i) => {
    if (action.action !== 'click') return true;
    const prev = actions[i - 1];
    if (!prev || prev.action !== 'press') return true;
    if (!ACTIVATION_KEYS.includes(prev.value ?? '')) return true;
    if (action.t - prev.t > KEY_ACTIVATION_MS) return true;
    return prev.target?.candidates[0] !== action.target?.candidates[0];
  });
}

/**
 * Navigations become steps only when nothing the user did explains them —
 * a typed URL or a back button. A navigation caused by clicking a link is the
 * click's reaction, and replaying both would double-navigate.
 */
function interleaveNavigations(actions: RawActionEvent[], trace: RecordingTrace): Pending[] {
  const merged: Pending[] = actions.map((a) => ({ ...a }));

  for (const nav of trace.navigations) {
    const caused = actions.some(
      (a) =>
        CAN_NAVIGATE.includes(a.action) && nav.t - a.t >= 0 && nav.t - a.t <= NAV_ATTRIBUTION_MS,
    );
    if (caused) continue;
    // Client-side routing is not a navigation the replayer can perform. Every
    // SPA pushes history on interaction — and on scroll, on filter, on tab —
    // and `framenavigated` reports all of it. Without this, a recording of a
    // routed app is mostly `goto` steps back to the page it is already on, and
    // replay reloads instead of exercising the flow.
    const loadedDocument = trace.documentLoads.some(
      (t) => t >= nav.t - DOCUMENT_LOAD_MS && t <= nav.t + DOCUMENT_LOAD_MS,
    );
    if (!loadedDocument) continue;
    merged.push({
      kind: 'action',
      action: 'goto',
      value: nav.url,
      target: null,
      t: nav.t,
      author: 'human',
      syntheticUrl: nav.url,
    });
  }

  return merged.sort((a, b) => a.t - b.t);
}

/** Navigating twice to the same URL in a row is one navigation. */
function collapseGotos(actions: Pending[]): Pending[] {
  return actions.filter((action, i) => {
    const prev = actions[i - 1];
    return !(prev && action.action === 'goto' && prev.action === 'goto' && prev.value === action.value);
  });
}

/** Collapse runs of scrolls on the same target down to the final position. */
function collapseScrolls(actions: Pending[]): Pending[] {
  const out: Pending[] = [];
  for (const action of actions) {
    const prev = out[out.length - 1];
    if (
      prev &&
      action.action === 'scroll' &&
      prev.action === 'scroll' &&
      prev.target?.candidates[0] === action.target?.candidates[0]
    ) {
      out[out.length - 1] = action;
      continue;
    }
    out.push(action);
  }
  return out;
}

export function compile(trace: RecordingTrace, options: CompileOptions): Repro {
  const rules = options.waitRules ?? DEFAULT_WAIT_RULES;
  const merged = collapseGotos(
    collapseScrolls(
      interleaveNavigations(
        mergeDoubleClicks(dropClickBeforeRightClick(dropSynthesizedActivation(trace.actions))),
        trace,
      ),
    ),
  );
  const traceEnd = trace.endedAt || Date.now();

  const ambientPatterns = ambientRequestPatterns(trace, rules);

  const steps: Step[] = merged.map((action, index) => {
    const next = merged[index + 1];
    // A step's reaction ends at the next action *or* at the next page load,
    // whichever comes first. Everything after a load belongs to the document
    // that replaced the one this step acted on; attributing it here recorded
    // signals the old page could never produce, and the step failed on replay
    // every time for a reason that had nothing to do with the bug.
    const nextLoad = trace.documentLoads.find((t) => t > action.t);
    const windowEnd = Math.min(next ? next.t : traceEnd, nextLoad ?? Number.POSITIVE_INFINITY);

    const step: Step = {
      id: `s${index + 1}`,
      action: action.action,
      value: action.value,
      waitAfter: buildWaitAfter(
        {
          actionAt: action.t,
          windowEnd,
          network: trace.network,
          dom: trace.dom,
          baseUrl: trace.baseUrl,
          ambientPatterns,
        },
        rules,
      ),
      author: action.author,
    };

    if (action.target) {
      step.target = { candidates: action.target.candidates, semantic: action.target.semantic };
    }

    const settled = trace.focus.filter((f) => f.t >= action.t && f.t <= windowEnd).pop();
    if (settled) step.focusedAfter = settled.selector;

    return step;
  });

  dropRerenderChurn(steps);

  return {
    version: IR_VERSION,
    name: options.name,
    createdAt: options.createdAt ?? new Date().toISOString(),
    baseUrl: trace.baseUrl,
    startPath: trace.startPath,
    viewport: trace.viewport,
    storageStatePath: options.storageStatePath,
    steps,
    assertion: deriveAssertion(steps, trace, options.observed),
  };
}

/** An error is the flow's evidence only if it landed in some action's wake. */
const REACTION_WINDOW_MS = 3_000;

/**
 * Endpoints the app calls on its own schedule.
 *
 * A keepalive or a poll fires whether or not anyone clicked, so it is never
 * evidence that a click caused anything — but it lives on the app's own API
 * host, which is exactly where host-based rules cannot reach. The tell is the
 * same one used for console output: it also happens when nothing was happening.
 */
function ambientRequestPatterns(trace: RecordingTrace, rules: WaitRules): Set<string> {
  const ambient = new Set<string>();
  if (!trace.actions.length) return ambient;

  const causedBySomeAction = (n: RawNetworkEvent): boolean =>
    trace.actions.some((a) => n.startedAt >= a.t && n.startedAt <= a.t + rules.triggerWindowMs);

  const unprompted = new Set<string>();
  const prompted = new Set<string>();
  for (const n of trace.network) {
    const key = `${n.method} ${normalizeUrlPattern(n.url, trace.baseUrl)}`;
    (causedBySomeAction(n) ? prompted : unprompted).add(key);
  }
  // Firing unprompted at any point is disqualifying, even if it also fired
  // after a click — a poll that happens to land in a window is still a poll.
  for (const key of unprompted) if (prompted.has(key)) ambient.add(key);
  for (const key of unprompted) ambient.add(key);
  return ambient;
}

interface ConsoleSplit {
  /** Errors plausibly caused by something the user did. */
  signature: string[];
  /** The app's own background chatter. */
  ambient: string[];
}

/**
 * Separate the app's noise from the bug's evidence.
 *
 * Splitting on "before the first action" was not stable: whether a boot error
 * landed in one bucket or the other depended on how quickly the recording
 * started clicking, so the same app and the same flow classified the same two
 * errors differently from run to run — and a recording that happened to start
 * fast treated boot chatter as the bug's signature.
 *
 * Causation is the stable question. Background noise fires whenever it fires;
 * evidence of a bug fires in the wake of an action. Anything outside every
 * action's reaction window is the app talking to itself, whenever it happened.
 *
 * The per-repro `ambient` list therefore holds only THIS app's own chatter.
 * Noise common to every app is handled by the shared filter and never recorded
 * here, so it cannot disable an otherwise dependable invariant.
 */
function splitConsole(trace: RecordingTrace): ConsoleSplit {
  const signature: string[] = [];
  const ambient: string[] = [];

  for (const entry of trace.console) {
    // Noise every app produces is filtered identically on both sides, so it
    // needs no per-repro baseline and must not weaken the invariant.
    if (isAmbientConsoleError(entry.text)) continue;
    // With no actions there is no causation to reason about, and nothing to
    // disprove attribution — so the error stands as evidence.
    if (!trace.actions.length) {
      signature.push(entry.text);
      continue;
    }
    const inWake = trace.actions.some(
      (a) => entry.t >= a.t && entry.t <= a.t + REACTION_WINDOW_MS,
    );
    (inWake ? signature : ambient).push(entry.text);
  }

  const ambientSet = new Set(ambient);
  return {
    // An error that also fires unprompted is noise even when it recurs after an
    // action, so ambient always wins the tie.
    signature: Array.from(new Set(signature)).filter((t) => !ambientSet.has(t)),
    ambient: Array.from(ambientSet),
  };
}

/**
 * Worth building an assertion on: named by the app, not by position or prose.
 *
 * A positional path or a text anchor may be fine for *finding* something to
 * click, where a wrong guess fails loudly. As a criterion it is far riskier —
 * it decides whether the bug is present, so a shaky one produces a confident
 * wrong verdict instead of an error.
 */
function isDurableSelector(selector: string): boolean {
  return selector.startsWith('[data-test') || selector.startsWith('#') || selector.startsWith('role=');
}

/**
 * A selector that vanishes on one step and returns on the next is a component
 * re-mounting, not a state change. Replay sees the element present throughout
 * and can satisfy neither half, so both are dropped.
 */
function dropRerenderChurn(steps: Step[]): void {
  for (let i = 0; i < steps.length - 1; i++) {
    const a = steps[i];
    const b = steps[i + 1];
    if (!a || !b) continue;
    const gone = new Set(a.waitAfter.domGone ?? []);
    const churned = (b.waitAfter.domAppeared ?? []).filter((s) => gone.has(s));
    if (!churned.length) continue;
    a.waitAfter.domGone = (a.waitAfter.domGone ?? []).filter((s) => !churned.includes(s));
    b.waitAfter.domAppeared = (b.waitAfter.domAppeared ?? []).filter((s) => !churned.includes(s));
    if (!a.waitAfter.domGone.length) delete a.waitAfter.domGone;
    if (!b.waitAfter.domAppeared.length) delete b.waitAfter.domAppeared;
  }
}

/**
 * Phase 0's assertion is whatever the recording ended in. Because a repro
 * captures the BUG, an invariant that the recording itself violated is not a
 * usable check — it would make a fresh repro fail its own replay. Those get
 * switched off here, and the violation is preserved under `observedAtRecord`
 * so `--expect-fixed` can later assert the bug is gone.
 */
export function deriveAssertion(
  steps: Step[],
  trace: RecordingTrace,
  observed?: { selector: string; absent: boolean }[],
): Assertion {
  const last = steps[steps.length - 1];

  const finalState: FinalState = {};
  // Anything the driver declared while the bug was on screen beats anything
  // inferred afterwards: it was checked at the moment it was known to be true.
  if (observed?.length) {
    const present = observed.filter((o) => !o.absent).map((o) => o.selector);
    const absent = observed.filter((o) => o.absent).map((o) => o.selector);
    if (present.length) finalState.domAppeared = present;
    if (absent.length) finalState.domGone = absent;
    return buildAssertion(finalState, trace);
  }
  if (last) {
    // Only what was still on screen when the recording stopped. A transition
    // the flow passed through is not the state it left behind, and asserting
    // one made a fresh repro fail its own replay.
    // Only positive, durable evidence, and only what is still on screen.
    //
    // Anything else is a guess about which part of the flow was the bug.
    // `domGone` in particular is unusable: almost everything is absent at the
    // end, so deriving one picks an incidental side effect and turns it into a
    // criterion — a BUG REPRODUCED waiting to be wrong. `network` is worse
    // still, since a request firing says nothing about what the app rendered.
    const survived = (last.waitAfter.domAppeared ?? [])
      .filter((s) => trace.presentAtEnd.includes(s))
      .filter(isDurableSelector);
    if (survived.length) finalState.domAppeared = survived;
    // Focus is deliberately NOT auto-asserted here; see `Step.focusedAfter`.
  }

  return buildAssertion(finalState, trace);
}

/** Everything that does not depend on where the criterion came from. */
function buildAssertion(finalState: FinalState, trace: RecordingTrace): Assertion {
  const { signature: consoleErrors, ambient: ambientConsoleErrors } = splitConsole(trace);

  // Third-party failures are not this app's bug and must not disable the check.
  const failedRequests = trace.network
    .filter((n) => n.failed && isSameOrigin(n.url, trace.baseUrl) && !isIncidentalRequest(n.url))
    .map((n) => ({
      urlPattern: normalizeUrlPattern(n.url, trace.baseUrl),
      method: n.method,
      status: n.status,
    }));
  const dedupedFailures = Array.from(
    new Map(failedRequests.map((f) => [`${f.method} ${f.urlPattern} ${f.status}`, f])).values(),
  );

  return {
    mode: 'expect-bug',
    finalState,
    invariants: {
      // Absence during one recording is not evidence of a clean app. An error
      // that fires intermittently at boot would be absent here and present on
      // the next run, silently flipping this invariant from run to run and
      // failing a healthy replay. If the app logs anything at all while
      // booting, the check is not dependable and expectedWhenFixed carries the
      // assertion instead.
      noConsoleErrors: consoleErrors.length === 0 && ambientConsoleErrors.length === 0,
      noFailedRequests: dedupedFailures.length === 0,
    },
    observedAtRecord: {
      consoleErrors,
      ambientConsoleErrors,
      failedRequests: dedupedFailures,
    },
  };
}
