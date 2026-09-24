import type { Page } from 'playwright';
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

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(300);
}

export function goalDrive(options: GoalOptions, client: JevClient): { drive: (page: Page, api: DriveApi) => Promise<void>; path: string[] } {
  const check = parseUntil(options.until);
  const maxSteps = options.maxSteps ?? 12;
  const taken: string[] = [];

  const drive = async (page: Page): Promise<void> => {
    await settle(page);
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
      await settle(page);
    }
  };

  return { drive, path: taken };
}
