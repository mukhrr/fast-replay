import type { Action, Author } from '../ir/schema.js';

/** Selector + semantic info resolved in the page, while the element is still live. */
export interface CapturedTarget {
  candidates: string[];
  semantic: string;
}

/** A user action, as captured in the page. */
export interface RawActionEvent {
  kind: 'action';
  action: Action;
  value: string | null;
  target: CapturedTarget | null;
  /** Date.now() at capture time. */
  t: number;
  author: Author;
}

/** A batch of DOM changes summarized as selectors that appeared or disappeared. */
export interface RawDomEvent {
  kind: 'dom';
  appeared: string[];
  gone: string[];
  t: number;
}

/** Where keyboard focus settled. Emitted only when it actually changed. */
export interface RawFocusEvent {
  kind: 'focus';
  /** CSS selector for the focused element; `body` when focus was lost. */
  selector: string;
  t: number;
}

export type PageEvent = RawActionEvent | RawDomEvent | RawFocusEvent;

export interface RawNavigationEvent {
  kind: 'navigation';
  url: string;
  t: number;
}

export interface RawNetworkEvent {
  kind: 'network';
  method: string;
  url: string;
  /** When the request was issued. */
  startedAt: number;
  /** When it settled (response or failure). Null while still in flight. */
  settledAt: number | null;
  status: number | null;
  failed: boolean;
}

export interface RawConsoleEvent {
  kind: 'console';
  text: string;
  t: number;
}

export type RawEvent =
  | RawActionEvent
  | RawDomEvent
  | RawNavigationEvent
  | RawFocusEvent
  | RawNetworkEvent
  | RawConsoleEvent;

/** Everything a recording session collected, in capture order per channel. */
export interface RecordingTrace {
  actions: RawActionEvent[];
  dom: RawDomEvent[];
  navigations: RawNavigationEvent[];
  focus: RawFocusEvent[];
  /**
   * Of everything that appeared during the recording, what was still present
   * when it ended.
   *
   * `finalState` must describe the state the flow leaves behind. Deriving it
   * from the last step's transitions asserted things that had already come and
   * gone — a modal heading that appeared and closed became a required end
   * state, and the repro failed its own replay.
   */
  presentAtEnd: string[];
  /**
   * Timestamps of real document loads.
   *
   * `framenavigated` also fires for History-API route changes, which every SPA
   * performs on every interaction. Only a genuine load can be replayed as a
   * `goto`; a route change is the consequence of whatever the user clicked.
   */
  documentLoads: number[];
  network: RawNetworkEvent[];
  console: RawConsoleEvent[];
  startedAt: number;
  endedAt: number;
  baseUrl: string;
  startPath: string;
  viewport: { width: number; height: number };
}
