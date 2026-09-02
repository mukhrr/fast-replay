import type { Browser, Page } from 'playwright';
import { captureStorageState, openBrowser } from '../browser.js';
import {
  attachRecorder,
  flushPageReactions,
  pathOf,
  resolvePresent,
  verifyInstrumentation,
  type StopReason,
} from './attach.js';
import { runStep, transitiveRequires, type LoadedStep } from '../steps.js';
import {
  ensuresVisible,
  establishSession,
  hostSlug,
  persistSession,
  sessionFiles,
  sessionKey,
  SHARING_DISABLED_WARNING,
  type SessionOutcome,
  type SessionPlan,
} from '../sessions.js';
import type { RecordingTrace } from './types.js';

export interface LaunchRecordingOptions {
  baseUrl: string;
  startPath?: string;
  viewport?: { width: number; height: number };
  /** Seed cookies/localStorage/IndexedDB from an existing Playwright state file. */
  storageStatePath?: string | null;
  /** Shared setup steps available to `drive` via `step(name)`. */
  steps?: Map<string, LoadedStep>;
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
  drive?: (page: Page, api: DriveApi) => Promise<void>;
  /**
   * Setup declared up front and run before `drive` gets the page.
   *
   * Declared rather than invoked so a session step can be seeded from the
   * project's stored session before the context exists, the only point at
   * which Playwright can seed one.
   */
  setup?: { step: string; params?: Record<string, string> }[];
  /** How the declared session step is seeded, decided by `planSession` before the browser opens. */
  session?: SessionPlan | null;
  /** Project root, where session files live. */
  root?: string;
  /** Record inside an already-running browser, e.g. the MCP server's pool. */
  browser?: Browser | null;
}

/**
 * What a programmatic recording can tell the recorder, beyond what it does.
 *
 * Reconstructing an assertion afterwards means naming a selector from memory
 * and hoping it still describes the moment you saw the bug. `observe` records
 * it at the point in the flow where it is known to be true, which is the only
 * place that knowledge exists.
 */
export interface DriveApi {
  /**
   * Run a shared setup step and confirm it reached the state it promises.
   *
   * The preamble to a bug — sign in, open a workspace — is the same across
   * most repros. Sharing it as a function means one place to fix when the app
   * moves, instead of re-recording every repro that walked through it.
   */
  step(name: string, params?: Record<string, string>): Promise<void>;
  /**
   * Record a selector as evidence of the bug, checked now.
   *
   * Throws if it does not currently hold, because an assertion that was already
   * false when written is worse than none — it would pass or fail for reasons
   * unrelated to the bug forever after.
   */
  observe(selector: string, options?: { absent?: boolean }): Promise<void>;
}

export interface RecordingResult {
  trace: RecordingTrace;
  /** Evidence the driver declared while the bug was on screen. */
  observed: { selector: string; absent: boolean }[];
  /** Shared setup the driver invoked, to be referenced rather than recorded. */
  setup: { step: string; params?: Record<string, string> }[];
  /**
   * Serialized session. Captured at the start of recording, then replaced with
   * the post-sign-in session once a session-establishing setup step has run —
   * so replay restores an authenticated state and never re-runs the sign-in.
   */
  storageState: string;
  stopReason: StopReason;
  /** Set when `drive` threw. The trace up to that point is still usable. */
  driveError: Error | null;
  /** The shared session this recording reused or wrote; null when the repro keeps its own state. */
  session: SessionOutcome | null;
  /** Non-fatal things the caller should show: sharing disabled and why, a start path that did not prove. */
  warnings: string[];
}

export const STOP_HOTKEY = 'Ctrl/Cmd + Shift + X';

export async function launchRecording(
  options: LaunchRecordingOptions,
): Promise<RecordingResult> {
  const viewport = options.viewport ?? { width: 1440, height: 900 };
  const startPath = options.startPath ?? '/';

  const plan = options.session ?? null;
  const opened = await openBrowser({
    headless: options.headless ?? false,
    viewport,
    storageStatePath: plan?.seedPath ?? options.storageStatePath ?? null,
    profileDir: options.profileDir ?? null,
    browser: options.browser ?? null,
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

    const observed: { selector: string; absent: boolean }[] = [];
    const setup: { step: string; params?: Record<string, string> }[] = [];
    const ranSteps = new Set<string>();
    const steps = options.steps ?? new Map<string, LoadedStep>();
    const root = options.root ?? process.cwd();
    const warnings: string[] = [];
    let sessionOutcome: SessionOutcome | null = null;
    // Overwritten each time a session-establishing step completes, so the final
    // value is the session as it stood once all sign-in was done.
    let sessionStorageState: string | null = null;

    const invoke = async (name: string, params?: Record<string, string>): Promise<void> => {
      // Nothing setup does belongs in the IR. Recorded, it is copied into
      // every repro that used it, and fixing the shared function would fix
      // none of them.
      session.suspend();
      try {
        await runStep(name, page, steps, ranSteps, params ?? {});
      } finally {
        session.resume();
      }
      setup.push({ step: name, ...(params ? { params } : {}) });
      // Sign-in may sit behind the invoked step as a `requires` dependency
      // rather than being invoked itself, so the whole chain decides whether
      // this call established a session.
      const sessionSteps = Array.from(transitiveRequires([name], steps))
        .map((n) => steps.get(n))
        .filter((s): s is LoadedStep => Boolean(s?.establishesSession));
      if (!sessionSteps.length) return;
      const state = await captureStorageState(context);
      sessionStorageState = state;

      // A session step invoked from drive() rather than declared still leaves
      // a shared session behind, under the same eligibility rules as a
      // declared one, so the next recording can declare it and skip the
      // sign-in this one paid. Only when the declared setup had no session
      // step at all: a plan that shared or refused already decided. Proof is
      // claimed only if the page happens to be on the start path right now;
      // navigating away would disrupt the driver mid-flow.
      const only = sessionSteps[0];
      if (
        plan?.target ||
        plan?.disabled ||
        sessionOutcome ||
        sessionSteps.length > 1 ||
        !only?.ensures ||
        options.storageStatePath ||
        options.profileDir
      ) {
        return;
      }
      const key = sessionKey(only.name, name === only.name ? (params ?? {}) : {});
      const host = hostSlug(options.baseUrl);
      const files = sessionFiles(root, key, host);
      const onStartPath = pathOf(page.url(), options.baseUrl) === startPath;
      const proven = onStartPath && (await ensuresVisible(page, only));
      // Off the start path nothing was measured, so the sidecar must not be
      // told "not proven": that would retract a path another recording proved.
      await persistSession(onStartPath ? files : { state: files.state, meta: null }, state, {
        path: startPath,
        proven,
      });
      sessionOutcome = { step: only.name, key, host, status: 'established', proven, statePath: files.state };
    };

    const api: DriveApi = {
      step: invoke,
      async observe(selector, opts) {
        const absent = Boolean(opts?.absent);
        const count = await page.locator(selector).count();
        const holds = absent ? count === 0 : count > 0;
        if (!holds) {
          throw new Error(
            `observe(${JSON.stringify(selector)}${absent ? ', { absent: true }' : ''}) does not hold right now. ` +
              `Recording an assertion that is already false would produce a verdict about something other than the bug.`,
          );
        }
        observed.push({ selector, absent });
      },
    };

    // Declared setup runs before the driver gets the page. The session step is
    // handled first so the rest of the declared steps find it already done.
    if (plan?.disabled) warnings.push(`${SHARING_DISABLED_WARNING}: ${plan.disabled}`);
    if (plan?.target) {
      session.suspend();
      try {
        const result = await establishSession({
          page,
          context,
          steps,
          ran: ranSteps,
          target: plan.target,
          startUrl,
          startPath,
          probe: plan.probe,
          persist: true,
        });
        sessionOutcome = {
          step: plan.target.step.name,
          key: plan.target.key,
          host: plan.target.host,
          status: result.status,
          proven: result.proven,
          statePath: plan.target.files.state,
        };
        if (!result.proven) {
          warnings.push(
            `step "${plan.target.step.name}" signed in, but its ensures (${plan.target.step.ensures}) is not visible on ${startPath}; ` +
              'this repro will restore the session without checking it',
          );
        }
      } finally {
        session.resume();
      }
    }
    for (const entry of options.setup ?? []) await invoke(entry.step, entry.params);

    let driveError: Error | null = null;
    let stopReason: StopReason;
    try {
      if (options.drive) {
        try {
          // A driven session ends when the driver is done — but an early browser
          // close or hotkey still wins, so takeover behaves the same either way.
          await Promise.race([
            options.drive(page, api).then(() => session.stop('programmatic')),
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

    return {
      trace: session.trace,
      // The post-sign-in session when there was one, else the starting session.
      storageState: sessionStorageState ?? storageState,
      stopReason,
      driveError,
      observed,
      setup,
      session: sessionOutcome,
      warnings,
    };
  } finally {
    await opened.close();
  }
}
