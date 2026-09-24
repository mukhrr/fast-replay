import { describe, expect, it } from 'vitest';
import { describeInputProblems } from '../src/jev/driver.js';

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
