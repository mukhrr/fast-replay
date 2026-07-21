import { describe, expect, it } from 'vitest';
import { assertRepro, fixRepro } from '../src/ir/edit.js';
import { parseRepro, type Repro } from '../src/ir/schema.js';

/**
 * Repairing a recording used to mean hand-writing JSON — a field report counted
 * nine rounds of it, roughly forty minutes, before a fresh recording would
 * replay at all. Each of these covers one of those rounds.
 */

const repro = (): Repro =>
  parseRepro(
    {
      version: 1,
      name: 'r',
      createdAt: new Date(0).toISOString(),
      baseUrl: 'http://localhost:3000',
      startPath: '/',
      viewport: { width: 800, height: 600 },
      steps: [
        {
          id: 's1',
          action: 'click',
          target: { candidates: ['div > div:nth-of-type(2)'], semantic: 'a' },
          waitAfter: {
            timeoutMs: 2000,
            network: [{ urlPattern: '/api/Ping', method: 'GET' }],
            domAppeared: ['role=img[name="Loading..."]', '#real'],
          },
        },
        { id: 's2', action: 'click', target: { candidates: ['#b'], semantic: 'b' }, waitAfter: { timeoutMs: 3000 } },
        { id: 's3', action: 'click', target: { candidates: ['#c'], semantic: 'c' }, waitAfter: { timeoutMs: 3000 } },
      ],
      assertion: { finalState: {}, invariants: {} },
    },
    'r.json',
  );

describe('repro fix', () => {
  it('scales and floors timeouts', () => {
    const { repro: out } = fixRepro(repro(), { scaleTimeouts: 3, minTimeout: 8000 });
    expect(out.steps.map((s) => s.waitAfter.timeoutMs)).toEqual([8000, 9000, 9000]);
  });

  it('drops network waits but keeps DOM signals', () => {
    const { repro: out, changes } = fixRepro(repro(), { relaxNetwork: true });
    expect(out.steps[0]!.waitAfter.network).toBeUndefined();
    expect(out.steps[0]!.waitAfter.domAppeared).toContain('#real');
    expect(changes.join()).toContain('1 network wait');
  });

  it('drops a single unwanted wait wherever it appears', () => {
    // The spinner case: recorded on a cold run, never renders on a warm one.
    const { repro: out } = fixRepro(repro(), { dropWaits: ['role=img[name="Loading..."]'] });
    expect(out.steps[0]!.waitAfter.domAppeared).toEqual(['#real']);
  });

  it('reports honestly when a selector matched nothing', () => {
    const { changes } = fixRepro(repro(), { dropWaits: ['#nope'] });
    expect(changes.join()).toContain('no wait matched #nope');
  });

  it('renumbers after removing a step, so ids match position', () => {
    // `Step s9 (step 8 of 8)` is a needless puzzle in the moment someone is
    // already editing JSON.
    const { repro: out } = fixRepro(repro(), { dropSteps: ['s2'] });
    expect(out.steps.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(out.steps.map((s) => s.target!.semantic)).toEqual(['a', 'c']);
  });

  it('puts a hand-supplied candidate ahead of the recorded guesses', () => {
    const { repro: out } = fixRepro(repro(), {
      addCandidates: ['s1=[data-testid="FABMenu-CreateExpense"]'],
    });
    expect(out.steps[0]!.target!.candidates[0]).toBe('[data-testid="FABMenu-CreateExpense"]');
    expect(out.steps[0]!.target!.candidates).toHaveLength(2);
  });

  it('rejects a malformed candidate spec instead of guessing', () => {
    const { changes } = fixRepro(repro(), { addCandidates: ['nonsense'] });
    expect(changes.join()).toContain('malformed');
  });

  it('leaves the input untouched', () => {
    const original = repro();
    fixRepro(original, { scaleTimeouts: 10, dropSteps: ['s1'] });
    expect(original.steps).toHaveLength(3);
    expect(original.steps[0]!.waitAfter.timeoutMs).toBe(2000);
  });

  it('still produces valid IR', () => {
    const { repro: out } = fixRepro(repro(), {
      scaleTimeouts: 2,
      relaxNetwork: true,
      relaxInvariants: true,
      dropSteps: ['s3'],
    });
    expect(() => parseRepro(JSON.parse(JSON.stringify(out)), 'x.json')).not.toThrow();
  });
});

describe('repro assert', () => {
  it('writes a fix criterion without touching the recorded final state', () => {
    const { repro: out } = fixRepro(repro(), {});
    const { repro: asserted } = assertRepro(out, {
      appeared: ['text=Total spend'],
      whenFixed: true,
    });
    expect(asserted.assertion.expectedWhenFixed?.domAppeared).toEqual(['text=Total spend']);
    expect(asserted.assertion.finalState.domAppeared).toBeUndefined();
  });

  it('authors a focus criterion', () => {
    const { repro: out } = assertRepro(repro(), {
      focused: 'button[aria-label^="Select a currency"]',
      whenFixed: true,
    });
    expect(asserted(out)).toBe('button[aria-label^="Select a currency"]');
    function asserted(r: Repro) {
      return r.assertion.expectedWhenFixed?.focused;
    }
  });

  it('accumulates rather than overwriting, unless cleared', () => {
    const one = assertRepro(repro(), { gone: ['#a'] }).repro;
    const two = assertRepro(one, { gone: ['#b'] }).repro;
    expect(two.assertion.finalState.domGone).toEqual(['#a', '#b']);

    const cleared = assertRepro(two, { clear: true, gone: ['#c'] }).repro;
    expect(cleared.assertion.finalState.domGone).toEqual(['#c']);
  });
});
