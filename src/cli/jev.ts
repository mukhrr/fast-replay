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
