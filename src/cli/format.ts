const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const ESC = '\u001b[';
const wrap = (code: number) => (s: string) => (useColor ? `${ESC}${code}m${s}${ESC}0m` : s);

export const bold = wrap(1);
export const dim = wrap(2);
export const red = wrap(31);
export const green = wrap(32);
export const yellow = wrap(33);
export const cyan = wrap(36);

export function ms(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`;
}

/** Compact relative age, e.g. "3m", "2h", "5d". */
export function age(iso: string | null): string {
  if (!iso) return '?';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '?';
  const secs = Math.max(0, (Date.now() - then) / 1000);
  if (secs < 60) return `${Math.floor(secs)}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Length ignoring ANSI escapes, so colored cells still align. */
function visibleLength(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[\d+m/g, '').length;
}

/** Left-aligned columns sized to their content. */
export function table(rows: string[][], gap = 2): string {
  if (!rows.length) return '';
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, visibleLength(cell));
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) =>
          i === row.length - 1
            ? cell
            : cell + ' '.repeat((widths[i] ?? 0) - visibleLength(cell) + gap),
        )
        .join(''),
    )
    .join('\n');
}
