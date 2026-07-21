import type { Page } from 'playwright';
import { captureStorageState, openBrowser } from '../browser.js';
import {
  attachRecorder,
  flushPageReactions,
  pathOf,
  resolvePresent,
  verifyInstrumentation,
  type StopReason,
} from './attach.js';
import type { RecordingTrace } from './types.js';

export interface LaunchRecordingOptions {
  baseUrl: string;
  startPath?: string;
  viewport?: { width: number; height: number };
  /** Seed cookies/localStorage/IndexedDB from an existing Playwright state file. */
  storageStatePath?: string | null;
  /** Record against a persistent Chromium profile instead of a fresh context. */
  profileDir?: string | null;
  /** Called once the browser is up and instrumented, so the CLI can print help. */
  onReady?: () => void;
  /** Recording is a human activity by default; only a driver makes it headless-able. */
  headless?: boolean;
  /**
   * Drive the session programmatically instead of waiting for a human. The
   * recording stops when this resolves.
   *
   * This is how Phase 1's `repro auto` will work: an LLM browser agent takes
   * the page and produces the exact same IR a human recording produces, because
   * capture happens below whoever is doing the driving.
   */
  drive?: (page: Page) => Promise<void>;
}

export interface RecordingResult {
  trace: RecordingTrace;
  /** Serialized storageState captured at the START of the recording. */
  storageState: string;
  stopReason: StopReason;
  /** Set when `drive` threw. The trace up to that point is still usable. */
  driveError: Error | null;
}

export const STOP_HOTKEY = 'Ctrl/Cmd + Shift + X';

export async function launchRecording(
  options: LaunchRecordingOptions,
): Promise<RecordingResult> {
  const viewport = options.viewport ?? { width: 1440, height: 900 };
  const startPath = options.startPath ?? '/';

  const opened = await openBrowser({
    headless: options.headless ?? false,
    viewport,
    storageStatePath: options.storageStatePath ?? null,
    profileDir: options.profileDir ?? null,
  });

  try {
    const { context, page } = opened;
    const session = await attachRecorder(context, { baseUrl: options.baseUrl });

    const startUrl = new URL(startPath, options.baseUrl).toString();
    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
    await verifyInstrumentation(page);

    // Snapshot session state before the dev touches anything, so replay starts
    // from exactly the auth/session the recording started from.
    const storageState = await captureStorageState(context);

    session.trace.startPath = pathOf(page.url(), options.baseUrl);
    session.trace.viewport = viewport;
    // The first navigation is the starting point, not a step.
    session.trace.navigations.length = 0;
    session.trace.documentLoads.length = 0;
    session.trace.focus.length = 0;
    // Neither is anything the page did to itself while booting. Layout probes
    // and autofocus fire real events before the user touches anything, and a
    // step recorded there is ordered ahead of the navigation that created the
    // page — so its selector can never resolve and step one always fails.
    session.trace.actions.length = 0;
    session.trace.dom.length = 0;

    options.onReady?.();

    const onSigint = (): void => session.stop('signal');
    process.once('SIGINT', onSigint);

    let driveError: Error | null = null;
    let stopReason: StopReason;
    try {
      if (options.drive) {
        try {
          // A driven session ends when the driver is done — but an early browser
          // close or hotkey still wins, so takeover behaves the same either way.
          await Promise.race([
            options.drive(page).then(() => session.stop('programmatic')),
            session.stopped,
          ]);
        } catch (err) {
          // A driver that throws halfway through still produced real steps.
          // Discarding them would throw away everything up to the failure —
          // which on a slow app can be several minutes of work.
          driveError = err instanceof Error ? err : new Error(String(err));
          session.stop('drive-failed');
        }
      }
      stopReason = await session.stopped;
    } finally {
      process.off('SIGINT', onSigint);
    }

    // Settle the last action's reaction, then give in-flight bindings and any
    // trailing network a moment to land, so the final step is not truncated by
    // the shutdown itself.
    await flushPageReactions(page);
    await new Promise((r) => setTimeout(r, 400));

    // Ask the page what actually survived, so the final assertion describes
    // where the flow ended rather than something it passed through.
    const appeared = Array.from(new Set(session.trace.dom.flatMap((d) => d.appeared)));
    session.trace.presentAtEnd = await resolvePresent(page, appeared);

    session.detach();

    return { trace: session.trace, storageState, stopReason, driveError };
  } finally {
    await opened.close();
  }
}
