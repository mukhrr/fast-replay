import type { FinalState, Repro, Step } from './schema.js';

/**
 * Programmatic repairs to a recorded IR.
 *
 * A recording is a first draft. Waits get captured that the app will not
 * reproduce, timeouts reflect the machine that recorded rather than the one
 * replaying, and a step occasionally lands that should not have. Every one of
 * those was previously a round of hand-editing JSON, and the gap between
 * "recorded" and "replayable" was measured in tens of minutes — which is a lot
 * for a tool whose entire promise is speed.
 *
 * Each operation returns a description of what it changed, so the command can
 * report the edit rather than leaving someone to diff the file.
 */

export interface EditResult {
  repro: Repro;
  changes: string[];
}

export interface FixOptions {
  /** Multiply every recorded timeout. */
  scaleTimeouts?: number;
  /** Raise any timeout below this floor. */
  minTimeout?: number;
  /** Drop network waits, keeping DOM signals. */
  relaxNetwork?: boolean;
  /** Turn off the console/request invariants. */
  relaxInvariants?: boolean;
  /** Remove these selectors from every wait, wherever they appear. */
  dropWaits?: string[];
  /** Remove these steps by id. */
  dropSteps?: string[];
  /** `s3=[data-testid="x"]` — add a selector candidate to one step. */
  addCandidates?: string[];
  /** Renumber step ids so they match position. */
  renumber?: boolean;
}

const clone = (repro: Repro): Repro => JSON.parse(JSON.stringify(repro)) as Repro;

function removeSelector(step: Step, selector: string): boolean {
  let changed = false;
  for (const key of ['domAppeared', 'domGone'] as const) {
    const list = step.waitAfter[key];
    if (!list?.includes(selector)) continue;
    const next = list.filter((s) => s !== selector);
    if (next.length) step.waitAfter[key] = next;
    else delete step.waitAfter[key];
    changed = true;
  }
  return changed;
}

/** Step ids are positional, so a structural edit must renumber to stay honest. */
function renumberSteps(repro: Repro): void {
  repro.steps.forEach((step, i) => {
    step.id = `s${i + 1}`;
  });
}

export function fixRepro(input: Repro, options: FixOptions): EditResult {
  const repro = clone(input);
  const changes: string[] = [];

  if (options.dropSteps?.length) {
    const before = repro.steps.length;
    repro.steps = repro.steps.filter((s) => !options.dropSteps!.includes(s.id));
    const removed = before - repro.steps.length;
    if (removed) {
      changes.push(`removed ${removed} step(s): ${options.dropSteps.join(', ')}`);
      // Always renumber after removal: `Step s9 (step 8 of 8)` is a needless
      // puzzle in exactly the moment someone is already editing JSON.
      renumberSteps(repro);
      changes.push('renumbered step ids to match position');
    }
  }

  if (options.relaxNetwork) {
    let count = 0;
    for (const step of repro.steps) {
      if (!step.waitAfter.network) continue;
      count += step.waitAfter.network.length;
      delete step.waitAfter.network;
    }
    if (repro.assertion.finalState.network) {
      count += repro.assertion.finalState.network.length;
      delete repro.assertion.finalState.network;
    }
    if (count) changes.push(`dropped ${count} network wait(s)`);
  }

  for (const selector of options.dropWaits ?? []) {
    let hits = 0;
    for (const step of repro.steps) if (removeSelector(step, selector)) hits++;
    for (const key of ['domAppeared', 'domGone'] as const) {
      const list = repro.assertion.finalState[key];
      if (list?.includes(selector)) {
        const next = list.filter((s) => s !== selector);
        if (next.length) repro.assertion.finalState[key] = next;
        else delete repro.assertion.finalState[key];
        hits++;
      }
    }
    changes.push(hits ? `dropped wait ${selector} from ${hits} place(s)` : `no wait matched ${selector}`);
  }

  if (options.scaleTimeouts && options.scaleTimeouts !== 1) {
    for (const step of repro.steps) {
      step.waitAfter.timeoutMs = Math.round(step.waitAfter.timeoutMs * options.scaleTimeouts);
    }
    changes.push(`scaled every timeout by ${options.scaleTimeouts}x`);
  }

  if (options.minTimeout) {
    let raised = 0;
    for (const step of repro.steps) {
      if (step.waitAfter.timeoutMs >= options.minTimeout) continue;
      step.waitAfter.timeoutMs = options.minTimeout;
      raised++;
    }
    if (raised) changes.push(`raised ${raised} timeout(s) to ${options.minTimeout}ms`);
  }

  if (options.relaxInvariants) {
    repro.assertion.invariants.noConsoleErrors = false;
    repro.assertion.invariants.noFailedRequests = false;
    changes.push('turned off noConsoleErrors and noFailedRequests');
  }

  for (const spec of options.addCandidates ?? []) {
    const at = spec.indexOf('=');
    if (at < 1) {
      changes.push(`skipped malformed --add-candidate "${spec}" (expected <stepId>=<selector>)`);
      continue;
    }
    const id = spec.slice(0, at);
    const selector = spec.slice(at + 1);
    const step = repro.steps.find((s) => s.id === id);
    if (!step?.target) {
      changes.push(`no step ${id} with a target to add a candidate to`);
      continue;
    }
    // Prepended: a hand-supplied selector is a correction, and the recorded
    // guesses that failed should be tried after it, not before.
    step.target.candidates = [selector, ...step.target.candidates.filter((c) => c !== selector)];
    changes.push(`added candidate to ${id}: ${selector}`);
  }

  if (options.renumber) {
    renumberSteps(repro);
    changes.push('renumbered step ids to match position');
  }

  return { repro, changes };
}

export interface AssertOptions {
  appeared?: string[];
  gone?: string[];
  focused?: string;
  /** Write into `expectedWhenFixed` rather than `finalState`. */
  whenFixed?: boolean;
  /** Empty the target assertion first. */
  clear?: boolean;
}

export function assertRepro(input: Repro, options: AssertOptions): EditResult {
  const repro = clone(input);
  const changes: string[] = [];
  const slot = options.whenFixed ? 'expectedWhenFixed' : 'finalState';

  const current: FinalState = options.clear
    ? {}
    : ((options.whenFixed ? repro.assertion.expectedWhenFixed : repro.assertion.finalState) ?? {});
  if (options.clear) changes.push(`cleared ${slot}`);

  const next: FinalState = { ...current };
  if (options.appeared?.length) {
    next.domAppeared = Array.from(new Set([...(next.domAppeared ?? []), ...options.appeared]));
    changes.push(`${slot}: require ${options.appeared.join(', ')} present`);
  }
  if (options.gone?.length) {
    next.domGone = Array.from(new Set([...(next.domGone ?? []), ...options.gone]));
    changes.push(`${slot}: require ${options.gone.join(', ')} gone`);
  }
  if (options.focused) {
    next.focused = options.focused;
    changes.push(`${slot}: require focus on ${options.focused}`);
  }

  if (options.whenFixed) repro.assertion.expectedWhenFixed = next;
  else repro.assertion.finalState = next;

  return { repro, changes };
}
