/** String and token helpers shared across the in-page agent. */

/** Collapse whitespace, trim, and cap length with an ellipsis. */
export function clean(s: string | null | undefined, max = 80): string {
  if (!s) return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Escape a value for use inside a double-quoted selector attribute. */
export function escAttr(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Escape an identifier for use in a CSS selector. */
export function escId(v: string): string {
  return typeof window.CSS?.escape === 'function'
    ? window.CSS.escape(v)
    : v.replace(/([^\w-])/g, '\\$1');
}

/**
 * Reject build-generated tokens. The goal is stability across rebuilds, so
 * anything carrying a content hash or a CSS-in-JS prefix is out.
 */
export function isStableToken(t: string): boolean {
  if (!t || t.length > 40) return false;
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(t)) return false;
  if (/^(css|sc|emotion|styled|jsx|glamor|makeStyles)-/i.test(t)) return false;
  if (/[0-9a-f]{6,}/i.test(t)) return false; // embedded hash
  if ((t.match(/\d/g) || []).length >= 3) return false; // numeric noise
  if (/[A-Z]/.test(t) && /\d/.test(t)) return false; // e.g. Button_root__2Xy4z
  return true;
}

export function isStableClass(c: string): boolean {
  return isStableToken(c) && !/^_/.test(c);
}

/**
 * Text as rendered. `textContent` concatenates across element boundaries —
 * a row reads "Sensor 2Delete" — whereas `innerText` respects layout and
 * separates them.
 */
export function renderedText(el: Element, max = 80): string {
  const inner = (el as HTMLElement).innerText;
  return clean(typeof inner === 'string' ? inner : el.textContent, max);
}
