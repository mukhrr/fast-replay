import type { Action } from '../../ir/schema.js';
import type { RawActionEvent } from '../types.js';
import type { AgentConfig } from './config.js';
import type { RevealTracker } from './reveal-tracker.js';
import { isEditable } from './roles.js';
import { describe } from './selectors.js';
import { clean } from './text.js';
import type { Transport } from './transport.js';

/**
 * Turns raw DOM events into recorded actions.
 *
 * Every listener is registered in the capturing phase on `document`, so an app
 * that calls `stopPropagation` cannot hide a user's action from the recorder.
 */

/**
 * How close two click events must be to be one physical click. A label
 * forwarding to its control dispatches synchronously; a human clicking twice
 * cannot get near this.
 */
const ECHO_WINDOW_MS = 30;

/** Keys that carry meaning outside a text field. */
const MEANINGFUL_KEYS = [
  'Enter',
  'Escape',
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Backspace',
  'Delete',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  ' ',
];

export interface CaptureContext {
  config: AgentConfig;
  transport: Transport;
  reveals: RevealTracker;
  /**
   * Called just before each action is recorded, so the DOM observer can settle
   * the previous action's reaction at the same moment replay would stop waiting
   * for it.
   */
  beforeAction?: () => void;
}

function targetOf(e: Event): Element | null {
  const t = e.target;
  return t && (t as Node).nodeType === 1 ? (t as Element) : null;
}

function playwrightKey(e: KeyboardEvent): string {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.metaKey) mods.push('Meta');
  if (e.shiftKey && e.key.length > 1) mods.push('Shift');
  const key = e.key === ' ' ? 'Space' : e.key;
  return [...mods, key].join('+');
}

function isStopHotkey(e: KeyboardEvent): boolean {
  return (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'x';
}

export function installCapture(ctx: CaptureContext): void {
  const { config, transport, reveals } = ctx;

  // fill: committed on change/blur, never per keystroke
  const focusValue = new WeakMap<Element, string>();
  const committed = new WeakMap<Element, string>();

  /**
   * One physical click can dispatch more than once. A `<label>` forwards to its
   * control; menu and dialog primitives re-dispatch a synthetic click on their
   * trigger. Replaying every copy runs a different flow than the one recorded —
   * two toggles instead of one, a menu opened and immediately closed.
   *
   * Tracked against the last click we actually RECORDED, never merely the last
   * one seen. If a click is dropped because its target has no usable selector,
   * the copy that follows must still be free to record: suppressing it too
   * would leave the gesture with no step at all, which is the one outcome worse
   * than a duplicate, because nothing in the artifact shows it happened.
   */
  let lastRecorded: { el: Element; t: number } | null = null;

  function isEchoOfRecordedClick(el: Element): boolean {
    const prev = lastRecorded;
    if (!prev) return false;
    // A forwarded or synthesized click lands in the same task as the one that
    // caused it. Anything slower is a person clicking again.
    if (Date.now() - prev.t > ECHO_WINDOW_MS) return false;
    if (prev.el === el) return true;
    if (prev.el.contains(el) || el.contains(prev.el)) return true;
    const label = el.closest('label');
    return Boolean(label && label === prev.el.closest('label'));
  }

  /** Returns false when the step was dropped for having no addressable target. */
  function emitAction(action: Action, el: Element | null, value: string | null): boolean {
    ctx.beforeAction?.();
    const target = el ? describe(el) : null;
    if (el && !target) return false; // nothing addressable — a step we could never replay
    const t = Date.now();
    reveals.noteAction(t);
    const ev: RawActionEvent = { kind: 'action', action, value, target, t, author: 'human' };
    transport.emit(ev);
    return true;
  }

  /** Emit the preceding hover first, when that hover is what revealed this target. */
  function flushRevealingHover(actionTarget: Element | null): void {
    const hovered = reveals.takeLoadBearingHover(actionTarget);
    if (hovered) emitAction('hover', hovered, null);
  }

  function valueOf(el: Element): string {
    if ((el as HTMLElement).isContentEditable) return clean((el as HTMLElement).innerText, 500);
    return (el as HTMLInputElement).value ?? '';
  }

  function commitFill(el: Element): void {
    if (!isEditable(el)) return;
    const value = valueOf(el);
    if (committed.get(el) === value) return;
    if (focusValue.get(el) === value && committed.get(el) === undefined) return;
    committed.set(el, value);
    flushRevealingHover(el);
    emitAction('fill', el, value);
  }

  /**
   * Commit an edit that is still sitting in the focused field before recording
   * whatever the user just did instead.
   *
   * `change`/`blur` are the commit triggers, but they are not guaranteed to
   * fire *before* the next action: programmatic drivers frequently move on
   * without blurring, which would emit the fill after the action it preceded
   * and put the IR out of order. This only fixes ordering — it never commits a
   * value that change/blur would not have committed anyway.
   */
  function flushPendingFill(): void {
    const active = document.activeElement;
    if (active && isEditable(active)) commitFill(active);
  }

  const on = <K extends keyof DocumentEventMap>(
    type: K,
    handler: (e: DocumentEventMap[K]) => void,
  ): void => {
    document.addEventListener(type, handler, true);
  };

  on('focusin', (e) => {
    const el = targetOf(e);
    if (el && isEditable(el)) focusValue.set(el, valueOf(el));
  });

  on('mouseover', (e) => {
    const el = targetOf(e);
    if (el) reveals.noteHover(el);
  });

  on('click', (e) => {
    const el = targetOf(e);
    if (!el) return;
    if (isEchoOfRecordedClick(el)) return;
    flushPendingFill();
    flushRevealingHover(el);
    if (emitAction('click', el, null)) lastRecorded = { el, t: Date.now() };
  });

  on('dblclick', (e) => {
    const el = targetOf(e);
    if (!el) return;
    flushPendingFill();
    emitAction('dblclick', el, null);
  });

  on('change', (e) => {
    const el = targetOf(e);
    if (!el) return;
    if (el.tagName.toLowerCase() === 'select') {
      const sel = el as HTMLSelectElement;
      const opt = sel.selectedOptions[0];
      flushPendingFill();
      flushRevealingHover(el);
      emitAction('select', el, opt ? opt.value || clean(opt.textContent) : sel.value);
      return;
    }
    // Checkbox/radio state changes are already represented by their click.
    if (isEditable(el)) commitFill(el);
  });

  on('blur', (e) => {
    const el = targetOf(e);
    if (el && isEditable(el)) commitFill(el);
  });

  on('keydown', (e) => {
    // Recording hotkey: swallowed entirely so it never lands in the IR.
    if (isStopHotkey(e)) {
      e.preventDefault();
      e.stopPropagation();
      transport.binding(config.stopBinding)?.({ reason: 'hotkey' });
      return;
    }

    const el = targetOf(e);
    if (isEditable(el)) {
      // Inside a field only Enter and Escape carry meaning (submit / dismiss).
      // Typing itself is captured as a single `fill` on commit.
      if (e.key !== 'Enter' && e.key !== 'Escape') return;
      commitFill(el);
    } else if (!MEANINGFUL_KEYS.includes(e.key) && !(e.ctrlKey || e.metaKey || e.altKey)) {
      return;
    } else {
      flushPendingFill();
    }
    emitAction('press', el, playwrightKey(e));
  });

  installScrollCapture(ctx, emitAction);
}

/**
 * Offscreen probe elements that libraries scroll programmatically to detect
 * resizes — element-resize-detector, react-virtualized, ResizeSensor. They fire
 * a scroll during layout that no user performed, and recording it produces a
 * step whose selector can never resolve.
 */
const RESIZE_PROBE = [
  '.erd_scroll_detection_container',
  '.resize-sensor',
  '.resize-triggers',
  '[data-resize-sensor]',
];

function isResizeProbe(el: Element | null): boolean {
  if (!el) return false;
  return RESIZE_PROBE.some((sel) => {
    try {
      return el.matches(sel) || el.closest(sel) !== null;
    } catch {
      return false;
    }
  });
}

/** Scroll is debounced and only recorded when the position actually moved. */
function installScrollCapture(
  ctx: CaptureContext,
  emitAction: (action: Action, el: Element | null, value: string | null) => void,
): void {
  const { config } = ctx;
  const lastPosition = new WeakMap<object, { x: number; y: number }>();
  const timers = new WeakMap<object, ReturnType<typeof setTimeout>>();

  document.addEventListener(
    'scroll',
    (e) => {
      const raw = e.target;
      if (raw && (raw as Node).nodeType === 1 && isResizeProbe(raw as Element)) return;
      const isDocument =
        !raw || raw === document || raw === document.documentElement || raw === document.body;
      const key: object = isDocument ? document : (raw as object);
      const el = isDocument ? null : (raw as Element);
      const x = el ? el.scrollLeft : window.scrollX;
      const y = el ? el.scrollTop : window.scrollY;

      const existing = timers.get(key);
      if (existing) clearTimeout(existing);
      timers.set(
        key,
        setTimeout(() => {
          const last = lastPosition.get(key) ?? { x: 0, y: 0 };
          const moved =
            Math.abs(x - last.x) >= config.scrollMinDeltaPx ||
            Math.abs(y - last.y) >= config.scrollMinDeltaPx;
          if (!moved) return;
          lastPosition.set(key, { x, y });
          emitAction('scroll', el, JSON.stringify({ x, y }));
        }, config.scrollDebounceMs),
      );
    },
    true,
  );
}
