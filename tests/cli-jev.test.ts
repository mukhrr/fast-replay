import { describe, expect, it } from 'vitest';
import { parseInputs, parseMaxSteps } from '../src/cli/jev.js';

describe('--input parsing', () => {
  it('splits on the first = only', () => {
    expect(parseInputs(['Report title=Weekly rollup', 'Note=a=b'])).toEqual({ 'Report title': 'Weekly rollup', Note: 'a=b' });
  });
  it('refuses a pair without =', () => {
    expect(() => parseInputs(['Title'])).toThrow(/--input "Title".*Label=value/);
  });
});

describe('--max-steps parsing', () => {
  it('accepts a positive whole number', () => {
    expect(parseMaxSteps('12')).toBe(12);
  });
  it.each(['abc', '0', '-1', '2.5'])('refuses %s', (value) => {
    expect(() => parseMaxSteps(value)).toThrow('--max-steps must be a positive whole number');
  });
});
