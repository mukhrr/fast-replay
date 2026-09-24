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
  return (await locator.count()) > 0 && (await locator.first().isVisible());
}

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
      const els: Element[] = [];
      const candidates: Candidate[] = [];
      const selector = 'button, a[href], [role="button"], [role="link"], [role="menuitem"], [role="tab"], input, select, textarea';
      for (const el of Array.from(document.querySelectorAll(selector))) {
        if (candidates.length >= max) break;
        const box = el.getBoundingClientRect();
        if (box.width === 0 || box.height === 0 || (el as HTMLButtonElement).disabled) continue;
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
          const label = labelOf(el);
          const value = inputs[label];
          if (value === undefined || (el as HTMLInputElement).type === 'password') continue;
          const current = tag === 'SELECT' ? (el as HTMLSelectElement).selectedOptions[0]?.text ?? '' : (el as HTMLInputElement).value;
          if (current === value) continue;
          candidates.push(
            tag === 'SELECT'
              ? { kind: 'select', value, desc: `choose "${value}" in the "${label}" field` }
              : { kind: 'fill', value, desc: `type "${value}" in the "${label}" field` },
          );
        } else {
          const name = (el.getAttribute('aria-label') || (el as HTMLElement).innerText || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
          if (!name) continue;
          const role = el.getAttribute('role') || (tag === 'A' ? 'link' : 'button');
          candidates.push({ kind: 'click', desc: `click ${role} "${name}"` });
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
