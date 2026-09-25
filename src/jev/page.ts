import type { ElementHandle, JSHandle, Page } from 'playwright';

export const MAX_CANDIDATES = 200;

export type UntilCheck = { kind: 'selector' | 'text' | 'url'; value: string };

export interface Candidate {
  kind: 'click' | 'fill' | 'select';
  desc: string;
  value?: string;
}

export function parseUntil(until: string): UntilCheck {
  const trimmed = until.trim();
  if (!trimmed) throw new Error('--until needs a selector, text=<visible text> or url=<part of the URL>');
  if (trimmed.startsWith('text=')) return { kind: 'text', value: trimmed.slice(5) };
  if (trimmed.startsWith('url=')) return { kind: 'url', value: trimmed.slice(4) };
  return { kind: 'selector', value: trimmed };
}

export async function untilHolds(page: Page, check: UntilCheck): Promise<boolean> {
  if (check.kind === 'url') return page.url().includes(check.value);
  const locator = check.kind === 'text' ? page.getByText(check.value, { exact: true }) : page.locator(check.value);
  // Any match a user can see counts: the first match may be a copy kept mounted under
  // an aria-hidden background screen, which would make the goal read as reached.
  const count = Math.min(await locator.count(), MAX_UNTIL_MATCHES);
  for (let i = 0; i < count; i++) {
    const match = locator.nth(i);
    const seen = await match
      .evaluate((el) => !el.closest('[aria-hidden="true"], [inert]'), undefined, { timeout: 1_000 })
      .then(async (exposed) => exposed && (await match.isVisible()))
      .catch(() => false);
    if (seen) return true;
  }
  return false;
}

/** Enough to get past hidden copies of the same text without scanning a whole list. */
const MAX_UNTIL_MATCHES = 50;

interface Collected {
  els: Element[];
  candidates: Candidate[];
}

export async function collectCandidates(
  page: Page,
  inputs: Record<string, string>,
): Promise<{ candidates: Candidate[]; element(i: number): Promise<ElementHandle<Element>>; dispose(): Promise<void> }> {
  // Element handles instead of marker attributes: the recorder watches the DOM,
  // and a marker could surface in a selector or a wait signal.
  const handle: JSHandle<Collected> = await page.evaluateHandle(
    ({ inputs, max }) => {
      const labelOf = (el: Element): string => {
        const id = el.getAttribute('id');
        const forLabel = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
        let text = (forLabel as HTMLElement | null)?.innerText || '';
        if (!text) {
          const wrapping = el.closest('label');
          if (wrapping) text = (wrapping.textContent ?? '').replace(el.textContent ?? '', '');
        }
        return (text || el.getAttribute('aria-label') || el.getAttribute('placeholder') || id || '').replace(/\s+/g, ' ').trim();
      };
      const clean = (t: string | null | undefined): string => (t ?? '').replace(/\s+/g, ' ').trim();
      const nameOf = (el: Element): string => {
        const by = el.getAttribute('aria-labelledby');
        const labelled = by ? by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ') : '';
        return clean(el.getAttribute('aria-label') || labelled);
      };
      // Mirrors what Playwright checks before a click, so Jev is only offered what a
      // click can reach instead of finding out through a 30 s actionability timeout.
      const usable = (el: Element): boolean => {
        const box = el.getBoundingClientRect();
        if (box.width === 0 || box.height === 0 || el.matches(':disabled')) return false;
        if (el.closest('[aria-hidden="true"], [inert], [aria-disabled="true"]')) return false;
        if (getComputedStyle(el).visibility !== 'visible') return false;
        const cx = box.left + box.width / 2;
        const cy = box.top + box.height / 2;
        if (cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight) {
          const root = el.getRootNode() as Document | ShadowRoot;
          const hit = root.elementFromPoint(cx, cy);
          return !!hit && (hit === el || el.contains(hit));
        }
        // Off screen: reachable only if no clipping ancestor hides it; a scrolling one can reveal it.
        for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
          const style = getComputedStyle(p);
          const clips = /hidden|clip/.test(style.overflowX + style.overflowY);
          const scrolls = /auto|scroll/.test(style.overflowX + style.overflowY);
          const r = p.getBoundingClientRect();
          const outside = box.bottom <= r.top || box.top >= r.bottom || box.right <= r.left || box.left >= r.right;
          if (outside && clips && !scrolls) return false;
        }
        return true;
      };
      const REGIONS: [string, string, boolean][] = [
        ['[role="dialog"], [role="alertdialog"], dialog, [aria-modal="true"]', 'dialog', false],
        ['nav, [role="navigation"]', 'navigation', false],
        ['aside, [role="complementary"]', 'sidebar', false],
        ['header, [role="banner"]', 'header', false],
        ['footer, [role="contentinfo"]', 'footer', false],
        ['form', 'form', true],
        ['section, [role="region"]', 'region', true],
      ];
      // Where a control lives tells apart controls that share a label, like two
      // "More" buttons or one "View details" per table row.
      const contextOf = (el: Element, ownName: string): string => {
        const parts: string[] = [];
        const row = el.closest('tr, [role="row"], li, [role="listitem"]');
        if (row) {
          const text = clean((row as HTMLElement).innerText.replace(ownName, '')).slice(0, 60);
          if (text) parts.push(`in row "${text}"`);
        }
        let region: { el: Element; kind: string; name: string } | null = null;
        for (const [sel, kind, needsName] of REGIONS) {
          const found = el.closest(sel);
          if (!found || (region && !region.el.contains(found))) continue;
          const name = nameOf(found);
          if (needsName && !name) continue;
          region = { el: found, kind, name };
        }
        if (region) parts.push(region.name ? `in ${region.kind} "${region.name}"` : `in ${region.kind}`);
        return parts.length ? ` ${parts.join(' ')}` : '';
      };
      const els: Element[] = [];
      const candidates: Candidate[] = [];
      const selector = 'button, a[href], [role="button"], [role="link"], [role="menuitem"], [role="tab"], input, select, textarea';
      for (const el of Array.from(document.querySelectorAll(selector))) {
        if (candidates.length >= max) break;
        if (!usable(el)) continue;
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
          const label = labelOf(el);
          if (!Object.hasOwn(inputs, label) || (el as HTMLInputElement).type === 'password') continue;
          const value = inputs[label]!;
          const current = tag === 'SELECT' ? (el as HTMLSelectElement).selectedOptions[0]?.text ?? '' : (el as HTMLInputElement).value;
          if (current === value) continue;
          const where = contextOf(el, '');
          candidates.push(
            tag === 'SELECT'
              ? { kind: 'select', value, desc: `choose "${value}" in the "${label}" field${where}` }
              : { kind: 'fill', value, desc: `type "${value}" in the "${label}" field${where}` },
          );
        } else {
          const name = (el.getAttribute('aria-label') || (el as HTMLElement).innerText || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
          if (!name) continue;
          const role = el.getAttribute('role') || (tag === 'A' ? 'link' : 'button');
          candidates.push({ kind: 'click', desc: `click ${role} "${name}"${contextOf(el, name)}` });
        }
        els.push(el);
      }
      return { els, candidates };
    },
    { inputs, max: MAX_CANDIDATES },
  );
  const candidates = await handle.evaluate((c) => c.candidates);
  return {
    candidates,
    element: async (i) => (await handle.evaluateHandle((c, i) => c.els[i]!, i)) as ElementHandle<Element>,
    dispose: () => handle.dispose(),
  };
}

/** Two reads this far apart that match mean the page has stopped rendering new controls. */
const STABLE_MS = 300;

/**
 * Collects candidates once the list stops changing. A single-page app can sit on a
 * splash screen with no network traffic, so network quiet alone does not mean ready;
 * an empty list never counts as stable, only the cap ends the wait for one.
 */
export async function waitForStableCandidates(
  page: Page,
  inputs: Record<string, string>,
  capMs: number,
): ReturnType<typeof collectCandidates> {
  const deadline = Date.now() + capMs;
  let found = await collectCandidates(page, inputs);
  for (;;) {
    if (Date.now() >= deadline) return found;
    await page.waitForTimeout(STABLE_MS);
    const next = await collectCandidates(page, inputs);
    const same =
      next.candidates.length > 0 &&
      next.candidates.length === found.candidates.length &&
      next.candidates.every((c, i) => c.desc === found.candidates[i]!.desc);
    await found.dispose();
    found = next;
    if (same) return found;
  }
}

export async function readPageState(
  page: Page,
): Promise<{ current_path: string; headings: string[]; fields: Record<string, string>; messages: string[]; passwordLabels: string[] }> {
  const inPage = await page.evaluate(() => {
    const labelOf = (el: Element): string => {
      const id = el.getAttribute('id');
      const forLabel = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      let text = (forLabel as HTMLElement | null)?.innerText || '';
      if (!text) {
        const wrapping = el.closest('label');
        if (wrapping) text = (wrapping.textContent ?? '').replace(el.textContent ?? '', '');
      }
      return (text || el.getAttribute('aria-label') || el.getAttribute('placeholder') || id || '').replace(/\s+/g, ' ').trim();
    };
    const fields: Record<string, string> = {};
    const passwordLabels: string[] = [];
    for (const el of Array.from(document.querySelectorAll('input, select, textarea'))) {
      const input = el as HTMLInputElement;
      if (input.type === 'hidden') continue;
      const label = labelOf(el);
      if (input.type === 'password') passwordLabels.push(label);
      fields[label] =
        input.type === 'password' ? '********' : el.tagName === 'SELECT' ? (el as HTMLSelectElement).selectedOptions[0]?.text ?? '' : input.value;
    }
    const texts = (sel: string) =>
      Array.from(document.querySelectorAll(sel)).map((e) => (e as HTMLElement).innerText.trim()).filter(Boolean);
    return { headings: texts('h1, h2'), fields, messages: texts('[role="status"], [role="alert"]'), passwordLabels };
  });
  let currentPath = page.url();
  try {
    currentPath = new URL(currentPath).pathname;
  } catch {
    // about:blank and friends have no pathname worth sending.
  }
  return { current_path: currentPath, ...inPage };
}
