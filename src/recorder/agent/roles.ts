import { escAttr, normalize } from './text.js';

/** ARIA roles and accessible names, computed from a live element. */

const TAG_ROLES: Record<string, string> = {
  button: 'button',
  select: 'combobox',
  textarea: 'textbox',
  nav: 'navigation',
  main: 'main',
  header: 'banner',
  footer: 'contentinfo',
  aside: 'complementary',
  form: 'form',
  table: 'table',
  tr: 'row',
  td: 'cell',
  th: 'columnheader',
  ul: 'list',
  ol: 'list',
  li: 'listitem',
  dialog: 'dialog',
  option: 'option',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
};

const INPUT_ROLES: Record<string, string> = {
  button: 'button',
  submit: 'button',
  reset: 'button',
  image: 'button',
  checkbox: 'checkbox',
  radio: 'radio',
  range: 'slider',
  number: 'spinbutton',
  search: 'searchbox',
  email: 'textbox',
  tel: 'textbox',
  text: 'textbox',
  url: 'textbox',
};

/** Roles whose accessible name comes from their own text content. */
const NAME_FROM_CONTENT = [
  'button',
  'link',
  'heading',
  'cell',
  'columnheader',
  'rowheader',
  'listitem',
  'option',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'treeitem',
  'switch',
  'checkbox',
  'radio',
];

const NON_EDITABLE_INPUTS = ['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image'];

export function getRole(el: Element): string | null {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit.trim().split(/\s+/)[0] || null;
  const tag = el.tagName.toLowerCase();
  if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
  if (tag === 'img') return el.getAttribute('alt') === '' ? null : 'img';
  if (tag === 'input') {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    return INPUT_ROLES[type] ?? null;
  }
  return TAG_ROLES[tag] ?? null;
}

/** Elements whose value is typed rather than toggled — the `fill` targets. */
export function isEditable(el: Element | null): el is HTMLElement {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  if (tag !== 'input') return false;
  const type = (el.getAttribute('type') || 'text').toLowerCase();
  return !NON_EDITABLE_INPUTS.includes(type);
}

/**
 * A pragmatic subset of the accname algorithm — enough to make role+name
 * selectors useful, without shipping the full 600-line spec. Order follows
 * accname's precedence for the sources we do implement.
 */
/**
 * The accessible name, computed the way Playwright's role engine computes it.
 *
 * A `role=` selector matches the whole name exactly, so a name built another way,
 * or shortened for display, resolves to nothing at replay.
 */
export function accessibleName(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria && aria.trim()) return normalize(aria);

  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const parts = labelledby
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .filter((n): n is HTMLElement => !!n)
      .map((n) => contentName(n));
    const joined = normalize(parts.filter(Boolean).join(' '));
    if (joined) return joined;
  }

  const tag = el.tagName.toLowerCase();
  if (['input', 'select', 'textarea'].includes(tag)) {
    const id = el.getAttribute('id');
    if (id) {
      const forLabel = document.querySelector(`label[for="${escAttr(id)}"]`);
      if (forLabel) {
        const t = normalize(contentName(forLabel));
        if (t) return t;
      }
    }
    const wrapping = el.closest('label');
    if (wrapping) {
      const t = normalize(contentName(wrapping));
      if (t) return t;
    }
  }

  for (const attr of ['alt', 'title', 'placeholder']) {
    const v = el.getAttribute(attr);
    if (v && v.trim()) return normalize(v);
  }

  const role = getRole(el);
  if (role && NAME_FROM_CONTENT.includes(role)) {
    const t = normalize(contentName(el));
    if (t) return t;
  }
  return '';
}

/**
 * Name from content: text, a child's own label or alt, nothing hidden, and a
 * space around every child that is not laid out inline, as the role engine does.
 */
function contentName(el: Element): string {
  let out = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? '';
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const child = node as Element;
    if (child.getAttribute('aria-hidden') === 'true') continue;
    const style = window.getComputedStyle(child);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const label = child.getAttribute('aria-label')?.trim() || (child.tagName === 'IMG' ? child.getAttribute('alt') ?? '' : '');
    const part = label || contentName(child);
    out += style.display === 'inline' && child.tagName !== 'BR' ? part : ` ${part} `;
  }
  return out;
}

/** Text of the element itself, used for the `text=` selector candidate. */
export function ownText(el: Element): string {
  return normalize(el.textContent);
}
