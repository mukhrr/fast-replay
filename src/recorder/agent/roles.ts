import { clean, escAttr } from './text.js';

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
export function accessibleName(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria && aria.trim()) return clean(aria);

  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const parts = labelledby
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .filter((n): n is HTMLElement => !!n)
      .map((n) => clean(n.textContent));
    const joined = clean(parts.filter(Boolean).join(' '));
    if (joined) return joined;
  }

  const tag = el.tagName.toLowerCase();
  if (['input', 'select', 'textarea'].includes(tag)) {
    const id = el.getAttribute('id');
    if (id) {
      const forLabel = document.querySelector(`label[for="${escAttr(id)}"]`);
      if (forLabel) {
        const t = clean(forLabel.textContent);
        if (t) return t;
      }
    }
    const wrapping = el.closest('label');
    if (wrapping) {
      const t = clean(wrapping.textContent);
      if (t) return t;
    }
  }

  for (const attr of ['alt', 'title', 'placeholder']) {
    const v = el.getAttribute(attr);
    if (v && v.trim()) return clean(v);
  }

  const role = getRole(el);
  if (role && NAME_FROM_CONTENT.includes(role)) {
    const t = clean(el.textContent);
    if (t) return t;
  }
  return '';
}

/** Text of the element itself, used for the `text=` selector candidate. */
export function ownText(el: Element): string {
  return clean(el.textContent, 60);
}
