import type { AgentConfig } from './config.js';

/**
 * Decides when a hover deserves to become a step of its own.
 *
 * Almost every hover is incidental mouse travel and must be dropped, or the IR
 * would be unreadable. The exception is the hover-to-open menu: if hovering
 * revealed the content we then acted on, replay must reproduce that hover or it
 * will click an element that is not there yet.
 *
 * This owns the three pieces of state that decision needs, which is why it is a
 * unit rather than loose variables shared between the observer and the capture
 * listeners.
 */
export interface RevealTracker {
  noteHover(el: Element): void;
  /** Called for every emitted action, to date the reveal cooldown. */
  noteAction(at: number): void;
  /** Called by the DOM observer with nodes that just became visible. */
  noteRevealed(nodes: Element[], at: number): void;
  /**
   * Consumes the pending reveal. Returns the hovered element only if it
   * revealed the thing being acted on now; null otherwise.
   */
  takeLoadBearingHover(actionTarget: Element | null): Element | null;
}

/**
 * DOM landing right after an action is that action's consequence, not a
 * hover's. Without this, clicking "Add" and then clicking inside the new row
 * would invent a bogus hover step on the Add button.
 */
const ACTION_COOLDOWN_MS = 600;

export function createRevealTracker(config: AgentConfig): RevealTracker {
  let pending: { el: Element; nodes: Element[]; at: number } | null = null;
  let lastHovered: Element | null = null;
  let lastActionAt = 0;

  return {
    noteHover(el) {
      lastHovered = el;
    },

    noteAction(at) {
      lastActionAt = at;
    },

    noteRevealed(nodes, at) {
      if (!nodes.length || !lastHovered) return;
      if (at - lastActionAt <= ACTION_COOLDOWN_MS) return;
      pending = { el: lastHovered, nodes, at };
    },

    takeLoadBearingHover(actionTarget) {
      const reveal = pending;
      pending = null;
      if (!reveal || !actionTarget) return null;
      if (Date.now() - reveal.at > config.hoverRevealWindowMs) return null;
      if (!reveal.el.isConnected) return null;
      // Load-bearing means: the thing we are about to act on lives inside what
      // the hover revealed.
      const inside = reveal.nodes.some((n) => n === actionTarget || n.contains(actionTarget));
      return inside ? reveal.el : null;
    },
  };
}
