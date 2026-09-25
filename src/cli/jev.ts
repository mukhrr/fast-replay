import readline from 'node:readline';

export const WHAT_IS_SENT = [
  'the goal text',
  'the URL path (no origin, no query)',
  'page headings',
  'names of visible buttons and links',
  'where each control sits: the text of its table row or list item, and its dialog, form or region name',
  'field labels and current values, passwords masked',
  'status messages',
  'the actions taken so far',
];

export function parseInputs(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    if (at <= 0) throw new Error(`--input "${pair}" is not Label=value`);
    out[pair.slice(0, at).trim()] = pair.slice(at + 1);
  }
  return out;
}

/** The prompt's answer for --input: `Label=value` pairs separated by `;`, since values may hold commas. */
export function parseInputList(answer: string): Record<string, string> {
  return parseInputs(
    answer
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean),
  );
}

/**
 * Asks for what `--goal`, `--until` and `--input` would carry, for a plain
 * `repro record` with a key set. Null means record by hand: an empty goal, or no
 * finish check after asking twice, since a goal without one would be a guess.
 */
export async function promptForGoal(
  ask: (question: string) => Promise<string>,
): Promise<{ goal: string; until: string; inputs: Record<string, string> } | null> {
  const goal = (await ask('Jev can walk to the bug. What should it do? (Enter to record by hand) ')).trim();
  if (!goal) return null;
  let until = '';
  for (let tries = 0; tries < 2 && !until; tries++) {
    until = (await ask('How do we know it got there? A selector, text=<exact visible text> or url=<part of the URL>: ')).trim();
  }
  if (!until) return null;
  const inputs = parseInputList(await ask('Values it may type, as Label=value separated by ; (Enter for none): '));
  return { goal, until, inputs };
}

/**
 * Visible questions on one terminal reader for the whole exchange: a reader per
 * question drops whatever was typed ahead or pasted along with the first answer.
 */
export async function withTerminalQuestions<T>(run: (ask: (question: string) => Promise<string>) => Promise<T>): Promise<T> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await run((question) => new Promise<string>((resolve) => rl.question(question, resolve)));
  } finally {
    rl.close();
  }
}

export function parseMaxSteps(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error('--max-steps must be a positive whole number');
  return n;
}

/** Reads piped stdin when there is one, otherwise prompts without echoing. */
export async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    let data = '';
    for await (const chunk of process.stdin) data += chunk;
    return data.trim();
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  process.stdout.write(prompt);
  // readline has no hidden mode; muting its echo is the standard workaround.
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
  const answer = await new Promise<string>((resolve) => rl.question('', resolve));
  rl.close();
  process.stdout.write('\n');
  return answer.trim();
}
