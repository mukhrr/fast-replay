export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const RETRY_DELAYS_MS = [500, 1000, 2000];

export interface ChoiceAnswer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface JevClient {
  choice(state: unknown, instructions: string, criteria: Record<string, string>): Promise<ChoiceAnswer>;
}

export class JevError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'invalid' | 'overloaded' | 'network',
  ) {
    super(message);
    this.name = 'JevError';
  }
}

export function createJevClient(
  key: string,
  options: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; timeoutMs?: number } = {},
): JevClient {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = options.timeoutMs ?? 30_000;

  return {
    async choice(state, instructions, criteria) {
      const body = JSON.stringify({
        model: 'jev-latest',
        state,
        questions: { next: { type: 'choice', instructions, criteria } },
      });
      for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
          res = await doFetch(JEV_ENDPOINT, {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body,
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (err) {
          throw new JevError(`Jev request failed: ${(err as Error).message}`, 'network');
        }
        if (res.ok) {
          const json = (await res.json()) as { answers: { next: ChoiceAnswer } };
          return json.answers.next;
        }
        if (res.status === 401 || res.status === 403) {
          throw new JevError('Jev rejected the API key. Run repro jev login with a valid key.', 'auth');
        }
        if (res.status === 422 || res.status === 400) {
          throw new JevError(`Jev refused the request: ${await res.text()}`, 'invalid');
        }
        if ((res.status === 429 || res.status === 529) && attempt < RETRY_DELAYS_MS.length) {
          await sleep(RETRY_DELAYS_MS[attempt]!);
          continue;
        }
        throw new JevError(`Jev is unavailable (HTTP ${res.status}) after ${attempt + 1} attempts.`, 'overloaded');
      }
    },
  };
}
