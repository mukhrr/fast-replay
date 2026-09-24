import { describe, expect, it } from 'vitest';
import { createJevClient, JevError, JEV_ENDPOINT } from '../src/jev/client.js';

const ok = (choice = 'c0') =>
  new Response(JSON.stringify({ model: 'jev-1', answers: { next: { type: 'choice', choice, confidence: 0.9, probabilities: { [choice]: 0.95, none: 0.05 } } } }), { status: 200 });

function fakeFetch(responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift()!;
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const noSleep = async () => {};

describe('jev client', () => {
  it('sends one choice question with the bearer key', async () => {
    const f = fakeFetch([ok('c1')]);
    const client = createJevClient('apikey_x', { fetch: f.fn, sleep: noSleep });
    const answer = await client.choice({ goal: 'g' }, 'Which?', { c0: 'a', c1: 'b', none: 'none' });
    expect(answer.choice).toBe('c1');
    expect(f.calls[0]).toBeDefined();
    expect(f.calls[0]!.url).toBe(JEV_ENDPOINT);
    expect((f.calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer apikey_x');
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({
      model: 'jev-latest',
      state: { goal: 'g' },
      questions: { next: { type: 'choice', instructions: 'Which?', criteria: { c0: 'a', c1: 'b', none: 'none' } } },
    });
  });

  it('does not retry a 401 and names repro jev login', async () => {
    const f = fakeFetch([new Response('{}', { status: 401 })]);
    const err = await createJevClient('k', { fetch: f.fn, sleep: noSleep }).choice({}, 'q', { a: 'a' }).catch((e) => e);
    expect(err).toBeInstanceOf(JevError);
    expect(err.kind).toBe('auth');
    expect(err.message).toMatch(/repro jev login/);
    expect(f.calls).toHaveLength(1);
  });

  it('retries 529 three times, then refuses as overloaded', async () => {
    const f = fakeFetch([529, 529, 529, 529].map((s) => new Response('{}', { status: s })));
    const err = await createJevClient('k', { fetch: f.fn, sleep: noSleep }).choice({}, 'q', { a: 'a' }).catch((e) => e);
    expect(err.kind).toBe('overloaded');
    expect(f.calls).toHaveLength(4);
  });

  it('recovers when a retry succeeds', async () => {
    const f = fakeFetch([new Response('{}', { status: 429 }), ok()]);
    const answer = await createJevClient('k', { fetch: f.fn, sleep: noSleep }).choice({}, 'q', { c0: 'a' });
    expect(answer.choice).toBe('c0');
  });

  it('passes the API message through on 422', async () => {
    const f = fakeFetch([new Response(JSON.stringify({ detail: 'criteria must not be empty' }), { status: 422 })]);
    const err = await createJevClient('k', { fetch: f.fn, sleep: noSleep }).choice({}, 'q', {}).catch((e) => e);
    expect(err.kind).toBe('invalid');
    expect(err.message).toMatch(/criteria must not be empty/);
  });

  it('reports a network failure by name', async () => {
    const f = fakeFetch([new TypeError('fetch failed')]);
    const err = await createJevClient('k', { fetch: f.fn, sleep: noSleep }).choice({}, 'q', { a: 'a' }).catch((e) => e);
    expect(err.kind).toBe('network');
    expect(err.message).toMatch(/fetch failed/);
  });
});
