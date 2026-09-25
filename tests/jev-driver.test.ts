import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { describeInputProblems, performAction } from '../src/jev/driver.js';
import { collectCandidates } from '../src/jev/page.js';

describe('describeInputProblems', () => {
  it('is silent when every requested label matches a fillable field', () => {
    expect(describeInputProblems({ Title: 'x' }, { Title: 'y' }, [])).toEqual([]);
  });

  it('is silent with no inputs requested', () => {
    expect(describeInputProblems(undefined, {}, [])).toEqual([]);
  });

  it('names input labels not found on the last page, with what is there instead', () => {
    expect(describeInputProblems({ Nonexistent: 'x' }, { Title: 'y' }, [])).toEqual([
      '--input labels not found on the last page: Nonexistent. Fields there: Title',
    ]);
  });

  it('says none when the last page has no fields at all', () => {
    expect(describeInputProblems({ Nonexistent: 'x' }, {}, [])).toEqual([
      '--input labels not found on the last page: Nonexistent. Fields there: none',
    ]);
  });

  it('names the password case for a label that names a password field', () => {
    expect(describeInputProblems({ Password: 'hunter2' }, { Password: '********' }, ['Password'])).toEqual([
      'password fields are never filled by Jev; sign in with --storage-state, --profile or a setup step',
    ]);
  });

  it('reports both problems when they both apply', () => {
    expect(describeInputProblems({ Password: 'x', Nonexistent: 'y' }, { Password: '********' }, ['Password'])).toEqual([
      '--input labels not found on the last page: Nonexistent. Fields there: Password',
      'password fields are never filled by Jev; sign in with --storage-state, --profile or a setup step',
    ]);
  });
});

describe('performAction', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => browser?.close());

  it('names the step and the option Jev picked when the action fails, within the short timeout', async () => {
    const page = await browser.newPage();
    await page.setContent('<button>Save</button>');
    const found = await collectCandidates(page, {});
    const el = await found.element(0);
    // Covered after it was offered, the way an overlay that opens late would.
    await page.evaluate(() => {
      const cover = document.createElement('div');
      cover.style.cssText = 'position:fixed;inset:0;background:#fff';
      document.body.appendChild(cover);
    });
    const started = Date.now();
    const err = await performAction(el, found.candidates[0]!, 3).catch((e: Error) => e);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(String((err as Error).message)).toMatch(/^step 3: click button "Save" failed: /);
    await found.dispose();
    await page.close();
  });
});

