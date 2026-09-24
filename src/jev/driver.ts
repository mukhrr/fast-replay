import type { Page, Request } from 'playwright';
import type { DriveApi } from '../recorder/launch.js';
import type { JevClient } from './client.js';
import { collectCandidates, parseUntil, readPageState, untilHolds } from './page.js';

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
  ) {
    super(
      reason === 'none'
        ? 'Jev found no action toward the goal'
        : `stopped after ${maxSteps} steps without reaching --until`,
    );
    this.name = 'GoalNotReached';
  }
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
 * Watches `page`'s requests for the life of one drive() run.
 *
 * `page.waitForLoadState('networkidle')` resolves immediately once the page
 * has already reached that state, so it never sees a fetch a click starts
 * afterward, which is exactly what clicking "Generate report" does. This
 * tracks requests directly, so settling means the click's own request
 * finished, not that the page loaded a while ago.
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

async function settle(page: Page, requests: RequestTracker): Promise<void> {
  await requests.waitForQuiet();
  await page.waitForTimeout(300);
}

export function goalDrive(options: GoalOptions, client: JevClient): { drive: (page: Page, api: DriveApi) => Promise<void>; path: string[] } {
  const check = parseUntil(options.until);
  const maxSteps = options.maxSteps ?? 12;
  const taken: string[] = [];

  const drive = async (page: Page): Promise<void> => {
    const requests = trackRequests(page);
    try {
      await settle(page, requests);
      for (let step = 0; ; step++) {
        if (await untilHolds(page, check)) return;
        if (step >= maxSteps) throw new GoalNotReached('max-steps', [...taken], maxSteps);
        const found = await collectCandidates(page, options.inputs ?? {});
        try {
          const criteria: Record<string, string> = { none: NONE };
          found.candidates.forEach((c, i) => (criteria[`c${i}`] = c.desc));
          const state = { goal: options.goal, ...(await readPageState(page)), recent_actions: [...taken] };
          // Act on the most probable option whatever its confidence: several fine next
          // actions split the probability, and only "none" winning means stop.
          const answer = await client.choice(state, JEV_INSTRUCTIONS, criteria);
          if (answer.choice === 'none' || !(answer.choice in criteria)) throw new GoalNotReached('none', [...taken], maxSteps);
          const index = Number(answer.choice.slice(1));
          const candidate = found.candidates[index]!;
          const el = await found.element(index);
          if (candidate.kind === 'click') await el.click();
          else if (candidate.kind === 'fill') await el.fill(candidate.value!);
          else await el.selectOption({ label: candidate.value! });
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
