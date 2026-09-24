import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { collectCandidates, parseUntil, readPageState, untilHolds } from '../src/jev/page.js';

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
      'click link "Home"',
      'click button "Save"',
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
