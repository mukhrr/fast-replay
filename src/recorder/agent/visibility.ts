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
  // An ancestor counts too: an app that keeps a background screen mounted under
  // aria-hidden or inert would otherwise hand replay a signal the role engine never sees.
  if (he.hidden || el.closest('[aria-hidden="true"], [inert]')) return false;
  const rect = he.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const cs = window.getComputedStyle(he);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
}

/**
 * Hidden from Playwright's `role=` engine, which skips these by default.
 *
 * A role selector for such an element matches nothing at replay, and counting it
 * among a role selector's matches shifts every `>> nth=` index after it.
 */
export function isHiddenForAria(el: Element): boolean {
  if (el.closest('[aria-hidden="true"]')) return true;
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    if (window.getComputedStyle(cur).display === 'none') return true;
  }
  const visibility = window.getComputedStyle(el).visibility;
  return visibility === 'hidden' || visibility === 'collapse';
}

