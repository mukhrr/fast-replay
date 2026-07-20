import type { BrowserContext, ConsoleMessage, Request, Response, WebError } from 'playwright';
import type { RawConsoleEvent, RawNetworkEvent } from './types.js';

/**
 * Buffers the environment's reaction — network traffic and console errors —
 * for the lifetime of a recording. Attribution to a specific action happens
 * later in the compiler, which is why everything here is just timestamped.
 */
export interface ReactionCollector {
  network: RawNetworkEvent[];
  console: RawConsoleEvent[];
  detach(): void;
}

const MAX_CONSOLE_TEXT = 500;

export function collectReactions(context: BrowserContext): ReactionCollector {
  const network: RawNetworkEvent[] = [];
  const console_: RawConsoleEvent[] = [];
  const inFlight = new Map<Request, RawNetworkEvent>();

  const onRequest = (request: Request): void => {
    const entry: RawNetworkEvent = {
      kind: 'network',
      method: request.method(),
      url: request.url(),
      startedAt: Date.now(),
      settledAt: null,
      status: null,
      failed: false,
    };
    inFlight.set(request, entry);
    network.push(entry);
  };

  const settle = (request: Request, status: number | null, failed: boolean): void => {
    const entry = inFlight.get(request);
    if (!entry) return;
    entry.settledAt = Date.now();
    entry.status = status;
    entry.failed = failed;
    inFlight.delete(request);
  };

  const onResponse = (response: Response): void => {
    const status = response.status();
    settle(response.request(), status, status >= 400);
  };

  const onRequestFailed = (request: Request): void => {
    // Navigations the user aborts are noise, not evidence of a bug.
    const aborted = request.failure()?.errorText === 'net::ERR_ABORTED';
    settle(request, null, !aborted);
  };

  const onConsole = (msg: ConsoleMessage): void => {
    if (msg.type() !== 'error') return;
    console_.push({ kind: 'console', text: msg.text().slice(0, MAX_CONSOLE_TEXT), t: Date.now() });
  };

  // Context-level uncaught page exceptions arrive as WebError, not Error.
  const onWebError = (webError: WebError): void => {
    const err = webError.error();
    const text = `${err.name}: ${err.message}`;
    console_.push({ kind: 'console', text: text.slice(0, MAX_CONSOLE_TEXT), t: Date.now() });
  };

  context.on('request', onRequest);
  context.on('response', onResponse);
  context.on('requestfailed', onRequestFailed);
  context.on('console', onConsole);
  context.on('weberror', onWebError);

  return {
    network,
    console: console_,
    detach() {
      context.off('request', onRequest);
      context.off('response', onResponse);
      context.off('requestfailed', onRequestFailed);
      context.off('console', onConsole);
      context.off('weberror', onWebError);
    },
  };
}
