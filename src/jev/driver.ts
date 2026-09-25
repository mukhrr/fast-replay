import type { Page, Request } from 'playwright';
import type { DriveApi } from '../recorder/launch.js';
import { JevError, type JevClient } from './client.js';
import { parseUntil, readPageState, untilHolds, waitForStableCandidates, type Candidate } from './page.js';
import type { ElementHandle } from 'playwright';

export interface GoalOptions {
  goal: string;
  until: string;
  inputs?: Record<string, string>;
  maxSteps?: number;
}

export class GoalNotReached extends Error {
  constructor(
    readonly reason: 'none' | 'max-steps',
    readonly path: string[],
    maxSteps: number,
    problems: string[] = [],
  ) {
    super(
      [
        reason === 'none' ? 'Jev found no action toward the goal' : `stopped after ${maxSteps} steps without reaching --until`,
        ...problems,
      ].join('\n'),
    );
    this.name = 'GoalNotReached';
  }
}

/**
 * Names what is wrong with `inputs`, based on the last page seen, for the
 * GoalNotReached message: a label matching no field at all, and separately a
 * label that names a password field, which Jev never fills.
 */
export function describeInputProblems(
  inputs: Record<string, string> | undefined,
  fields: Record<string, string>,
  passwordLabels: string[],
): string[] {
  const labels = Object.keys(inputs ?? {});
  if (!labels.length) return [];
  const notFound = labels.filter((l) => !(l in fields));
  const problems: string[] = [];
  if (notFound.length) {
    const known = Object.keys(fields);
    problems.push(
      `--input labels not found on the last page: ${notFound.join(', ')}. Fields there: ${known.length ? known.join(', ') : 'none'}`,
    );
  }
  if (labels.some((l) => passwordLabels.includes(l))) {
    problems.push('password fields are never filled by Jev; sign in with --storage-state, --profile or a setup step');
  }
  return problems;
}

export const JEV_INSTRUCTIONS =
  'A user is operating a web app to accomplish `goal`. `fields` shows current form values and `messages` shows visible status text. ' +
  '`recent_actions` lists what was already done; an earlier click may need repeating if its effect is not visible yet. ' +
  'Which available action should happen next? Pick none only if no action serves the goal.';

const NONE = 'None of these actions moves closer to the goal, or the goal is not possible in this app';

/** No requests in flight for this long counts as settled. */
const QUIET_MS = 500;
/** Ceiling for one settle, so a page that never goes quiet cannot hang the loop. */
const MAX_SETTLE_MS = 10_000;
const POLL_MS = 50;

interface RequestTracker {
  waitForQuiet(): Promise<void>;
  dispose(): void;
}

/**
 * Watches `page`'s requests for the life of one drive() run: `waitForLoadState('networkidle')`
 * would miss a fetch a click starts once the page is already idle, so this tracks requests directly instead.
 */
function trackRequests(page: Page): RequestTracker {
  const inFlight = new Set<Request>();
  let lastActivityAt = Date.now();

  const onStart = (req: Request): void => {
    inFlight.add(req);
    lastActivityAt = Date.now();
  };
  const onDone = (req: Request): void => {
    inFlight.delete(req);
    lastActivityAt = Date.now();
  };

  page.on('request', onStart);
  page.on('requestfinished', onDone);
  page.on('requestfailed', onDone);

  return {
    dispose(): void {
      page.off('request', onStart);
      page.off('requestfinished', onDone);
      page.off('requestfailed', onDone);
    },
    // Resets the clock on every call, so a request from several steps ago
    // cannot count as "just settled" and only what starts after this action
    // (or is still pending from before it) can hold up the wait.
    async waitForQuiet(): Promise<void> {
      lastActivityAt = Date.now();
      const deadline = Date.now() + MAX_SETTLE_MS;
      while (inFlight.size > 0 || Date.now() - lastActivityAt < QUIET_MS) {
        if (Date.now() >= deadline) return;
        await page.waitForTimeout(POLL_MS);
      }
    },
  };
}

/**
 * Candidates are checked for reachability before Jev sees them, so an action that
 * still cannot land within this long has met a change after the check, not a slow page.
 */
const ACTION_TIMEOUT_MS = 5_000;

/** Performs the chosen action, naming the step and option if it fails so a run can be diagnosed. */
export async function performAction(el: ElementHandle<Element>, candidate: Candidate, step: number): Promise<void> {
  try {
    if (candidate.kind === 'click') await el.click({ timeout: ACTION_TIMEOUT_MS });
    else if (candidate.kind === 'fill') await el.fill(candidate.value!, { timeout: ACTION_TIMEOUT_MS });
    else await el.selectOption({ label: candidate.value! }, { timeout: ACTION_TIMEOUT_MS });
  } catch (err) {
    throw new Error(`step ${step}: ${candidate.desc} failed: ${(err as Error).message.split('\n')[0]}`);
  }
}

async function settle(page: Page, requests: RequestTracker): Promise<void> {
  await requests.waitForQuiet();
  await page.waitForTimeout(300);
}

export function goalDrive(options: GoalOptions, client: JevClient): { drive: (page: Page, api: DriveApi) => Promise<void>; path: string[] } {
  const check = parseUntil(options.until);
  const maxSteps = options.maxSteps ?? 12;
  const taken: string[] = [];

  const drive = async (page: Page, api: DriveApi): Promise<void> => {
    const requests = trackRequests(page);
    try {
      await settle(page, requests);
      for (let step = 0; ; step++) {
        if (await untilHolds(page, check)) {
          // --until is the evidence of the bug, so it is kept as a drive file's observe() keeps it.
          if (check.kind !== 'url') await api.observe(check.kind === 'text' ? `text=${JSON.stringify(check.value)}` : check.value);
          return;
        }
        if (step >= maxSteps) {
          const { passwordLabels, fields } = await readPageState(page);
          throw new GoalNotReached('max-steps', [...taken], maxSteps, describeInputProblems(options.inputs, fields, passwordLabels));
        }
        const found = await waitForStableCandidates(page, options.inputs ?? {}, MAX_SETTLE_MS);
        try {
          const criteria: Record<string, string> = { none: NONE };
          found.candidates.forEach((c, i) => (criteria[`c${i}`] = c.desc));
          const { passwordLabels, ...pageState } = await readPageState(page);
          const state = { goal: options.goal, ...pageState, recent_actions: [...taken] };
          // Act on the most probable option whatever its confidence: several fine next
          // actions split the probability, and only "none" winning means stop.
          const answer = await client.choice(state, JEV_INSTRUCTIONS, criteria);
          if (answer.choice === 'none') {
            throw new GoalNotReached('none', [...taken], maxSteps, describeInputProblems(options.inputs, pageState.fields, passwordLabels));
          }
          // `in` also matches inherited keys like "constructor", which is not an offered
          // option and previously slipped past this check as if Jev had chosen it.
          if (!Object.hasOwn(criteria, answer.choice)) throw new JevError('Jev chose an option that was not offered.', 'invalid');
          const index = Number(answer.choice.slice(1));
          const candidate = found.candidates[index]!;
          await performAction(await found.element(index), candidate, step + 1);
          taken.push(candidate.desc);
        } finally {
          await found.dispose();
        }
        await settle(page, requests);
      }
    } finally {
      requests.dispose();
    }
  };

  return { drive, path: taken };
}
