import type { PageEvent } from '../types.js';
import type { AgentConfig } from './config.js';

const DRAIN_INTERVAL_MS = 25;

export interface Transport {
  emit(ev: PageEvent): void;
  /** Look up a Playwright-exposed binding, or null if it is not installed yet. */
  binding(name: string): ((arg: unknown) => unknown) | null;
}

/**
 * Carries events from the page to Node over a Playwright exposed binding.
 *
 * Bindings are not guaranteed to exist when the first events fire, so events
 * queue until one appears rather than being dropped on the floor.
 */
export function createTransport(config: AgentConfig): Transport {
  const globals = window as unknown as Record<string, unknown>;
  const pending: PageEvent[] = [];
  let drainTimer: ReturnType<typeof setInterval> | null = null;

  function binding(name: string): ((arg: unknown) => unknown) | null {
    const fn = globals[name];
    return typeof fn === 'function' ? (fn as (arg: unknown) => unknown) : null;
  }

  function drain(): void {
    const fn = binding(config.emitBinding);
    if (!fn) return;
    while (pending.length) {
      const ev = pending.shift();
      try {
        fn(ev);
      } catch {
        /* page torn down mid-emit */
      }
    }
    if (drainTimer) {
      clearInterval(drainTimer);
      drainTimer = null;
    }
  }

  function emit(ev: PageEvent): void {
    pending.push(ev);
    if (binding(config.emitBinding)) drain();
    else if (!drainTimer) drainTimer = setInterval(drain, DRAIN_INTERVAL_MS);
  }

  return { emit, binding };
}
