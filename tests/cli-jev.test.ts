import { describe, expect, it } from 'vitest';
import { parseInputList, promptForGoal, parseInputs, parseMaxSteps } from '../src/cli/jev.js';

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

const scripted = (answers: string[]) => {
  const asked: string[] = [];
  return { asked, ask: async (q: string) => (asked.push(q), answers.shift() ?? '') };
};

describe('promptForGoal', () => {
  it('builds a goal from the three answers', async () => {
    const { ask } = scripted(['Add a sensor named Boiler inlet', 'text=Boiler inlet', 'New sensor name=Boiler inlet; Note=a=b']);
    expect(await promptForGoal(ask)).toEqual({
      goal: 'Add a sensor named Boiler inlet',
      until: 'text=Boiler inlet',
      inputs: { 'New sensor name': 'Boiler inlet', Note: 'a=b' },
    });
  });

  it('records by hand when the goal is left empty, asking nothing else', async () => {
    const { ask, asked } = scripted(['']);
    expect(await promptForGoal(ask)).toBeNull();
    expect(asked).toHaveLength(1);
  });

  it('asks for the finish check again once, then records by hand', async () => {
    const { ask, asked } = scripted(['Open reports', '', '']);
    expect(await promptForGoal(ask)).toBeNull();
    expect(asked).toHaveLength(3);
  });

  it('takes no values when that answer is empty', async () => {
    const { ask } = scripted(['Open reports', 'url=/reports', '']);
    expect((await promptForGoal(ask))?.inputs).toEqual({});
  });
});

describe('parseInputList', () => {
  it('splits on ; and ignores blanks', () => {
    expect(parseInputList(' Title=Weekly ;; Sensor=Sensor 3 ')).toEqual({ Title: 'Weekly', Sensor: 'Sensor 3' });
  });
});

