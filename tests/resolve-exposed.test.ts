import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveTarget } from '../src/replayer/resolve.js';
import { waitForReaction } from '../src/replayer/waits.js';

/**
 * Replay resolves a selector to one element. When a background screen stays
 * mounted under aria-hidden, the first match in the DOM is a copy nobody can
 * click, so resolution prefers a match a user can actually reach.
 */

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});
afterAll(async () => browser?.close());

const target = (selector: string) => ({ candidates: [selector], semantic: 'the "More" button' });
const idOf = async (selector: string) => {
  const resolved = await resolveTarget(page, target(selector) as never);
  return resolved.locator.evaluate((el) => el.id);
};

describe('resolveTarget', () => {
  it('prefers the copy a user can reach over an aria-hidden twin earlier in the DOM', async () => {
    await page.setContent(`
      <div aria-hidden="true"><button id="bg">More</button></div>
      <div inert><button id="inert">More</button></div>
      <button id="fg">More</button>`);
    expect(await idOf('button:has-text("More")')).toBe('fg');
  });

  it('skips a first match that is not rendered', async () => {
    await page.setContent('<button id="gone" style="display:none">More</button><button id="fg">More</button>');
    expect(await idOf('button:has-text("More")')).toBe('fg');
  });

  it('still resolves when every match sits under aria-hidden, as an icon inside a button does', async () => {
    await page.setContent('<button><svg id="icon" aria-hidden="true" width="10" height="10"></svg></button>');
    expect(await idOf('#icon')).toBe('icon');
  });
});

describe('waitForReaction', () => {
  it('sees an appeared signal whose first match is not rendered', async () => {
    await page.setContent(`<p class="toast" style="display:none">old</p>
      <script>setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<p class="toast">Saved</p>'), 200);</script>`);
    const outcome = await waitForReaction(
      { page, baseUrl: 'about:blank', network: [], since: Date.now() },
      { domAppeared: ['.toast'], timeoutMs: 3_000 } as never,
    );
    expect(outcome.ok).toBe(true);
  });
});
