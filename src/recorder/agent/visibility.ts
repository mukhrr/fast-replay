/**
 * Is the element actually rendered?
 *
 * Used to keep unwaitable signals out of the IR. An `<option>` inside a
 * `<select>` is in the DOM but has no layout box, so a replay waiting for it to
 * become visible would hang until the step timed out.
 */
export function isVisible(el: Element): boolean {
  if (!el.isConnected) return false;
  const he = el as HTMLElement;
  if (he.hidden || el.getAttribute('aria-hidden') === 'true') return false;
  const rect = he.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const cs = window.getComputedStyle(he);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
}
