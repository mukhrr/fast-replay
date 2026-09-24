import { describe, expect, it } from 'vitest';
import { parseInputs } from '../src/cli/jev.js';

describe('--input parsing', () => {
  it('splits on the first = only', () => {
    expect(parseInputs(['Report title=Weekly rollup', 'Note=a=b'])).toEqual({ 'Report title': 'Weekly rollup', Note: 'a=b' });
  });
  it('refuses a pair without =', () => {
    expect(() => parseInputs(['Title'])).toThrow(/--input "Title".*Label=value/);
  });
});
