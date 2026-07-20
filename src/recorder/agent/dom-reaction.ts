import type { AgentConfig } from './config.js';
import type { RevealTracker } from './reveal-tracker.js';
import { appearedSelector, goneSelector } from './selectors.js';
import type { Transport } from './transport.js';
import { isVisible } from './visibility.js';

/**
 * Summarizes DOM mutations into the appeared/gone selectors that become a
 * step's `waitAfter`. This is what lets replay wait on a real signal instead of
 * a guessed sleep.
 */

/** Descendants worth checking inside an added subtree. */
const INTERESTING = '[data-testid], [data-test], [data-test-id], [data-cy], [id], [role], button, a[href]';

const OBSERVED_ATTRS = ['class', 'style', 'hidden', 'aria-hidden'];

export interface DomReactionContext {
  config: AgentConfig;
  transport: Transport;
  reveals: RevealTracker;
}

function harvest(
  nodes: NodeList,
  into: Set<string>,
  pick: (el: Element) => string | null,
  revealed: Element[],
  max: number,
): void {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!node || node.nodeType !== 1) continue;
    const el = node as Element;
    revealed.push(el);

    const own = pick(el);
    if (own && into.size < max) into.add(own);

    const descendants = el.querySelectorAll(INTERESTING);
    for (let j = 0; j < descendants.length && into.size < max; j++) {
      const d = descendants[j];
      if (!d) continue;
      const sel = pick(d);
      if (sel) into.add(sel);
    }
  }
}

export function observeDomReactions(ctx: DomReactionContext): void {
  const { config, transport, reveals } = ctx;
  const visibility = new WeakMap<Element, boolean>();

  // Only rendered elements make usable appear-signals; see visibility.ts.
  const visibleAppearedSelector = (el: Element): string | null =>
    isVisible(el) ? appearedSelector(el) : null;

  const start = (): void => {
    const observer = new MutationObserver((records) => {
      const appeared = new Set<string>();
      const gone = new Set<string>();
      const revealed: Element[] = [];

      for (const rec of records) {
        if (rec.type === 'childList') {
          harvest(rec.addedNodes, appeared, visibleAppearedSelector, revealed, config.maxSelectorsPerMutation);
          harvest(rec.removedNodes, gone, goneSelector, [], config.maxSelectorsPerMutation);
          continue;
        }

        // An attribute change can flip visibility without touching the tree —
        // the CSS-hidden toast case, which childList alone would miss.
        const el = rec.target as Element;
        const sel = appearedSelector(el);
        if (!sel) continue;
        const now = isVisible(el);
        const was = visibility.get(el);
        visibility.set(el, now);
        // First sighting only seeds the cache; it is not a transition.
        if (was === undefined || was === now) continue;
        if (now) {
          appeared.add(sel);
          revealed.push(el);
        } else {
          const g = goneSelector(el);
          if (g) gone.add(g);
        }
      }

      const at = Date.now();
      reveals.noteRevealed(revealed, at);

      if (appeared.size || gone.size) {
        transport.emit({
          kind: 'dom',
          appeared: Array.from(appeared),
          gone: Array.from(gone),
          t: at,
        });
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: OBSERVED_ATTRS,
    });
  };

  // The init script can run before <html> exists.
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
}
