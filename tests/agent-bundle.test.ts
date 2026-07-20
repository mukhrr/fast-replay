import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { AGENT_BUNDLE_FILE, buildAgentBundle, renderModule } from '../scripts/build-agent.js';
import { DEFAULT_AGENT_CONFIG, agentSource } from '../src/recorder/instrument.js';
import { AGENT_READY_FLAG } from '../src/recorder/agent/config.js';

describe('agent bundle', () => {
  it('is in sync with its source', async () => {
    // A stale bundle means edits to the agent silently do not reach the browser.
    const expected = renderModule(await buildAgentBundle());
    const committed = await readFile(AGENT_BUNDLE_FILE, 'utf8');
    expect(
      committed,
      'Agent bundle is stale. Run `npm run build:agent`.',
    ).toBe(expected);
  });

  it('carries no build helpers into page scope', () => {
    // The original failure: esbuild keepNames emitted __name(), undefined in the
    // page, so the agent threw on its first line and recorded nothing at all.
    const source = agentSource(DEFAULT_AGENT_CONFIG);
    for (const helper of ['__name(', '__publicField(', '__toESM(', '__commonJS(']) {
      expect(source, `bundle leaks ${helper}`).not.toContain(helper);
    }
  });

  it('installs in a real browser and reports itself ready', async () => {
    // The end-to-end guarantee: this exact string, evaluated in a real page,
    // installs cleanly. No test-double can vouch for that.
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });

      await page.setContent('<button data-testid="go">Go</button>');
      await page.evaluate(agentSource(DEFAULT_AGENT_CONFIG));

      const ready = await page.evaluate(
        (flag) => Boolean((window as unknown as Record<string, unknown>)[flag]),
        AGENT_READY_FLAG,
      );

      expect(errors).toEqual([]);
      expect(ready).toBe(true);
    } finally {
      await browser.close();
    }
  });

  it('captures a click through the bundled agent', async () => {
    // Proves the listeners are live, not merely that the script parsed.
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      const captured: unknown[] = [];
      await context.exposeBinding(DEFAULT_AGENT_CONFIG.emitBinding, (_s, ev) => {
        captured.push(ev);
      });
      const page = await context.newPage();
      await page.setContent('<button data-testid="go">Go</button>');
      await page.evaluate(agentSource(DEFAULT_AGENT_CONFIG));

      await page.click('[data-testid="go"]');
      await expect.poll(() => captured.length).toBeGreaterThan(0);

      const action = captured.find(
        (e) => (e as { kind?: string }).kind === 'action',
      ) as { action: string; target: { candidates: string[] } } | undefined;
      expect(action?.action).toBe('click');
      expect(action?.target.candidates[0]).toBe('[data-testid="go"]');
    } finally {
      await browser.close();
    }
  });
});
