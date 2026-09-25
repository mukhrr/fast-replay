import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { collectCandidates, parseUntil, readPageState, untilHolds, waitForStableCandidates } from '../src/jev/page.js';

let browser: Browser;
let page: Page;

const HTML = `
<h1>Account</h1><h2>Security</h2>
<nav><a href="/home">Home</a><button>Save</button><button disabled>Locked</button><button style="display:none">Hidden</button></nav>
<label for="t">Title</label><input id="t" value="draft">
<label for="p">Password</label><input id="p" type="password" value="hunter2">
<label for="s">Sensor</label><select id="s"><option>Sensor 1</option><option>Sensor 3</option></select>
<input aria-label="Search">
<div role="status">Saved</div>`;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});
afterAll(async () => browser?.close());

describe('parseUntil', () => {
  it('reads selector, text= and url= forms', () => {
    expect(parseUntil('[data-testid="x"]')).toEqual({ kind: 'selector', value: '[data-testid="x"]' });
    expect(parseUntil('text=Report ready')).toEqual({ kind: 'text', value: 'Report ready' });
    expect(parseUntil('url=/reports')).toEqual({ kind: 'url', value: '/reports' });
  });
  it('refuses an empty check', () => {
    expect(() => parseUntil('  ')).toThrow(/--until/);
  });
});

describe('page primitives', () => {
  it('checks until against the live page', async () => {
    await page.setContent(HTML);
    expect(await untilHolds(page, parseUntil('text=Saved'))).toBe(true);
    expect(await untilHolds(page, parseUntil('text=Nope'))).toBe(false);
    expect(await untilHolds(page, parseUntil('h2'))).toBe(true);
    expect(await untilHolds(page, parseUntil('url=about:blank'))).toBe(true);
  });

  it('offers visible enabled controls and only fields named in inputs', async () => {
    await page.setContent(HTML);
    const found = await collectCandidates(page, { Title: 'Weekly', Sensor: 'Sensor 3', Search: 'x' });
    expect(found.candidates.map((c) => c.desc)).toEqual([
      'click link "Home" in navigation',
      'click button "Save" in navigation',
      'type "Weekly" in the "Title" field',
      'choose "Sensor 3" in the "Sensor" field',
      'type "x" in the "Search" field',
    ]);
    await found.dispose();
  });

  it('skips a field that already holds its value', async () => {
    await page.setContent(HTML);
    const found = await collectCandidates(page, { Title: 'draft' });
    expect(found.candidates.some((c) => c.desc.includes('Title'))).toBe(false);
    await found.dispose();
  });

  it('acts on the element it offered without writing to the DOM', async () => {
    await page.setContent(HTML);
    const before = await page.content();
    const found = await collectCandidates(page, { Title: 'Weekly' });
    const idx = found.candidates.findIndex((c) => c.kind === 'fill');
    await (await found.element(idx)).fill('Weekly');
    await found.dispose();
    expect(await page.inputValue('#t')).toBe('Weekly');
    expect(before).not.toMatch(/data-jev/);
    expect(await page.content()).not.toMatch(/data-jev/);
  });

  it('masks password values in the state sent to Jev', async () => {
    await page.setContent(HTML);
    const state = await readPageState(page);
    expect(state.headings).toEqual(['Account', 'Security']);
    expect(state.fields).toEqual({ Title: 'draft', Password: '********', Sensor: 'Sensor 1', Search: '' });
    expect(state.messages).toEqual(['Saved']);
  });

  it('labels a field by id when it has no label, aria-label or placeholder', async () => {
    await page.setContent('<input id="qty">');
    const found = await collectCandidates(page, { qty: '3' });
    expect(found.candidates.map((c) => c.desc)).toEqual(['type "3" in the "qty" field']);
    await found.dispose();
    const state = await readPageState(page);
    expect(state.fields).toEqual({ qty: '' });
  });

  it('labels a field wrapped in a label when there is no label[for] match', async () => {
    await page.setContent('<label>Email <input></label>');
    const found = await collectCandidates(page, { Email: 'a@b.c' });
    expect(found.candidates.map((c) => c.desc)).toEqual(['type "a@b.c" in the "Email" field']);
    await found.dispose();
    const state = await readPageState(page);
    expect(state.fields).toEqual({ Email: '' });
  });

  it('reports which fields are password fields, without sending it to Jev', async () => {
    await page.setContent(HTML);
    const state = await readPageState(page);
    expect(state.passwordLabels).toEqual(['Password']);
  });
});

const descs = async (html: string, inputs: Record<string, string> = {}) => {
  await page.setContent(html);
  const found = await collectCandidates(page, inputs);
  const out = found.candidates.map((c) => c.desc);
  await found.dispose();
  return out;
};

describe('only controls a user can use', () => {
  it('skips a twin hidden from assistive tech behind an overlay', async () => {
    expect(
      await descs(`
        <div aria-hidden="true"><button>More</button></div>
        <div role="dialog" aria-label="Expense" style="position:fixed;inset:0;background:#fff"><button>More</button></div>`),
    ).toEqual(['click button "More" in dialog "Expense"']);
  });

  it('skips a control another element covers', async () => {
    expect(
      await descs(`
        <button>Covered</button><button style="position:relative;z-index:2">Open</button>
        <div style="position:fixed;top:0;left:0;width:60px;height:60px;background:#fff;z-index:1"></div>`),
    ).toEqual(['click button "Open"']);
  });

  it('skips inert, visibility:hidden and aria-disabled controls', async () => {
    expect(
      await descs(`
        <div inert><button>Inert</button></div>
        <button style="visibility:hidden">Invisible</button>
        <button aria-disabled="true">Off</button>
        <fieldset disabled><button>Fieldset</button></fieldset>
        <button>On</button>`),
    ).toEqual(['click button "On"']);
  });

  it('offers a control below the fold that scrolling reaches, not one clipped away', async () => {
    expect(
      await descs(`
        <div style="height:3000px"></div><button>Below</button>
        <div style="overflow:hidden;height:40px"><div style="height:400px"></div><button>Clipped</button></div>`),
    ).toEqual(['click button "Below"']);
  });
});

describe('where a control lives', () => {
  it('names the row a control sits in', async () => {
    expect(
      await descs(`
        <table><tr><td>Taxi</td><td>$9.12</td><td><button>View details</button></td></tr>
        <tr><td>Hotel</td><td>$120.00</td><td><button>View details</button></td></tr></table>`),
    ).toEqual(['click button "View details" in row "Taxi $9.12"', 'click button "View details" in row "Hotel $120.00"']);
  });

  it('names the dialog or landmark around a field too', async () => {
    expect(
      await descs(`<form aria-label="Split"><label for="a">Amount</label><input id="a"></form>`, { Amount: '5' }),
    ).toEqual(['type "5" in the "Amount" field in form "Split"']);
  });
});

describe('waitForStableCandidates', () => {
  it('waits past a splash screen that has no controls yet', async () => {
    await page.setContent(`<div id="app">Loading</div>
      <script>setTimeout(() => { document.getElementById('app').innerHTML = '<button>Start</button>'; }, 1200);</script>`);
    const found = await waitForStableCandidates(page, {}, 10_000);
    expect(found.candidates.map((c) => c.desc)).toEqual(['click button "Start"']);
    await found.dispose();
  });

  it('returns what it has when the page stays empty until the cap', async () => {
    await page.setContent('<p>Nothing to click</p>');
    const started = Date.now();
    const found = await waitForStableCandidates(page, {}, 1_000);
    expect(found.candidates).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    await found.dispose();
  });
});

describe('untilHolds sees only what a user sees', () => {
  it('does not hold on matching text hidden from assistive tech in a background screen', async () => {
    await page.setContent('<div aria-hidden="true"><p>Tax no longer valid.</p></div><div inert><p>Saved</p></div>');
    expect(await untilHolds(page, parseUntil('text=Tax no longer valid.'))).toBe(false);
    expect(await untilHolds(page, parseUntil('text=Saved'))).toBe(false);
  });

  it('holds when a later match is visible even though the first is not', async () => {
    await page.setContent('<p style="display:none">Done</p><div aria-hidden="true"><p class="r">Done</p></div><p class="r">Done</p>');
    expect(await untilHolds(page, parseUntil('text=Done'))).toBe(true);
    expect(await untilHolds(page, parseUntil('p.r'))).toBe(true);
  });
});

