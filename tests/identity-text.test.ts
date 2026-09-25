import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identityText } from '../src/replayer/perform.js';
import { identityMatches } from '../src/replayer/resolve.js';
import { bundleForPage } from './helpers/bundle.js';

/**
 * The identity recorded for a target and the text replay reads back before acting
 * must come from the same sources, or a correct row is refused and a wrong one can pass.
 */

let browser: Browser;
let page: Page;
let bundle: string;

beforeAll(async () => {
  bundle = await bundleForPage(`import { identityOf } from './selectors.js'; (window as any).identityOf = identityOf;`);
  browser = await chromium.launch();
  page = await browser.newPage();
}, 60_000);
afterAll(async () => browser?.close());

const ROWS = `
  <div role="button" tabindex="0" id="car"><div class="hit" style="width:100px;height:10px"></div><div>Sep 24</div>
    <span aria-label="Edit">E</span><div>Car</div><div>$9.12</div><div>Tax no longer valid.</div></div>
  <div role="button" tabindex="0" id="tpl"><div class="hit" style="width:100px;height:10px"></div><div>Sep 20</div>
    <span aria-label="Edit">E</span><div>Template</div><div>$325.00</div></div>
  <ul><li id="s2">Sensor 2 <button aria-label="Delete Sensor 2">Delete</button></li>
      <li id="s3">Sensor 3 <button aria-label="Delete Sensor 3">Delete</button></li></ul>`;

async function recordedAndFound(recordAt: string, replayAt: string): Promise<[string, string]> {
  await page.setContent(ROWS);
  await page.evaluate(bundle);
  const identity = await page.evaluate((sel) => (window as any).identityOf(document.querySelector(sel)), recordAt);
  const found = await page.locator(replayAt).evaluate(identityText);
  return [identity, found];
}

describe('identity recorded vs identity read at replay', () => {
  it('matches the same composite row', async () => {
    const [identity, found] = await recordedAndFound('#car .hit', '#car');
    expect(identity).toBeTruthy();
    expect(identityMatches(found, identity)).toBe(true);
  });

  it('refuses a different composite row', async () => {
    const [identity, found] = await recordedAndFound('#car .hit', '#tpl');
    expect(identityMatches(found, identity)).toBe(false);
  });

  it('matches the same labelled button and refuses its neighbour', async () => {
    const [identity, same] = await recordedAndFound('#s2 button', '#s2 button');
    const [, other] = await recordedAndFound('#s2 button', '#s3 button');
    expect(identityMatches(same, identity)).toBe(true);
    expect(identityMatches(other, identity)).toBe(false);
  });

  it('names a select by its label, not its options, so new options do not refuse it', async () => {
    await page.setContent('<label for="s">Sensor</label><select id="s"><option>Sensor 1</option><option>Boiler inlet</option></select>');
    await page.evaluate(bundle);
    const identity = await page.evaluate(() => (window as any).identityOf(document.getElementById('s')));
    expect(identity).toBe('Sensor');
    await page.evaluate(() => document.getElementById('s')!.insertAdjacentHTML('beforeend', '<option>Boiler-x1</option>'));
    expect(identityMatches(await page.locator('#s').evaluate(identityText), identity)).toBe(true);
  });
});

