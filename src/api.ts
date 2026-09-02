import path from 'node:path';
import type { Browser, Page } from 'playwright';
import { openBrowser } from './browser.js';
import { compile } from './compiler/compile.js';
import {
  listRepros,
  readRepro,
  reproPaths,
  writeFileAtomic,
  writeLastResult,
  writeRepro,
  type ReproSummary,
} from './ir/io.js';
import { launchRecording, STOP_HOTKEY, type DriveApi } from './recorder/launch.js';
import { loadSteps, STEPS_DIR, type LoadedStep } from './steps.js';
import { planSession, type SessionOutcome } from './sessions.js';
import { resolveSessionSeed, runRepro, type RunOptions, type RunResult } from './replayer/run.js';
import type { Repro } from './ir/schema.js';

/** `WxH` as typed on a command line or in a tool call. */
export function parseViewport(value: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/.exec(value.trim());
  if (!match) throw new Error(`Invalid viewport "${value}". Expected WxH, e.g. 1440x900.`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

export interface RecordOptions {
  name: string;
  baseUrl: string;
  startPath?: string;
  viewport?: { width: number; height: number };
  root?: string;
  /** Seed cookies/localStorage/IndexedDB from an existing Playwright state file. */
  storageStatePath?: string | null;
  /** Use a persistent Chromium profile instead of a fresh context. */
  profileDir?: string | null;
  onReady?: () => void;
  headless?: boolean;
  /**
   * Drive the browser programmatically instead of waiting for a human. The
   * capture pipeline is identical either way — the seam Phase 1's `repro auto`
   * hands to an LLM browser agent.
   */
  drive?: (page: Page, api: DriveApi) => Promise<void>;
  /** Directory of shared setup steps. Defaults to `.repros/steps`. */
  stepsDir?: string | null;
  /**
   * Shared setup declared up front and run before `drive` gets the page.
   *
   * Declared rather than invoked so a session step is seeded from the project's
   * stored session before the context exists. `api.step()` inside `drive`
   * still works for everything else.
   */
  setup?: { step: string; params?: Record<string, string> }[];
  /** Record inside an already-running browser, e.g. the MCP server's pool. */
  browser?: Browser | null;
}

export interface RecordResult {
  repro: Repro;
  irPath: string;
  stopReason: string;
  /** The shared session reused or written; null when the repro keeps its own state file. */
  session: SessionOutcome | null;
  /** Non-fatal things worth printing: sharing disabled and why, a start path that did not prove. */
  warnings: string[];
}

/**
 * The driver failed part-way, but the steps captured before it did were written
 * to disk anyway. Carries the path so the caller can inspect or resume.
 */
export class PartialRecordingError extends Error {
  constructor(
    override readonly cause: Error,
    readonly irPath: string,
    readonly repro: Repro,
  ) {
    super(
      `Recording stopped early after ${repro.steps.length} step(s): ${cause.message}\n` +
        `The partial repro was still written to ${irPath}`,
    );
    this.name = 'PartialRecordingError';
    // Node prints an error's own enumerable properties, so an attached repro
    // buried the one line that says what went wrong under the whole IR.
    Object.defineProperty(this, 'repro', { enumerable: false });
    Object.defineProperty(this, 'cause', { enumerable: false });
  }
}

/**
 * Drive a real browser, capture the flow, compile it to IR on disk.
 *
 * This — not the CLI — is the product's entry point. `repro record` is a thin
 * wrapper, and the Phase 1 MCP server will wrap this same function so an agent
 * verifies a fix in one call with no per-step round trips.
 */
export async function record(options: RecordOptions): Promise<RecordResult> {
  const root = options.root ?? process.cwd();
  const paths = reproPaths(options.name, root);

  const { steps: sharedSteps, errors: stepErrors } = await loadSteps(
    options.stepsDir ?? path.join(root, STEPS_DIR),
  );
  for (const e of stepErrors) {
    process.stderr.write(`warning: shared step ${e.file} could not be loaded — ${e.message}\n`);
  }

  const declared = options.setup ?? [];
  const plan = planSession({
    root,
    baseUrl: options.baseUrl,
    startPath: options.startPath ?? '/',
    setup: declared,
    steps: sharedSteps,
    explicitSeed: options.storageStatePath ? 'storage-state' : options.profileDir ? 'profile' : null,
  });

  const { trace, storageState, stopReason, driveError, observed, setup, session, warnings } =
    await launchRecording({
      baseUrl: options.baseUrl,
      startPath: options.startPath,
      viewport: options.viewport,
      storageStatePath: options.storageStatePath ?? null,
      profileDir: options.profileDir ?? null,
      onReady: options.onReady,
      headless: options.headless,
      drive: options.drive,
      steps: sharedSteps,
      setup: declared,
      session: plan,
      root,
      browser: options.browser ?? null,
    });

  // A shared session is referenced, not copied: one file to refresh when it
  // expires, and no per-repro snapshot to go stale beside it.
  let storageStatePath: string;
  if (session) {
    storageStatePath = path.relative(root, session.statePath);
  } else {
    await writeFileAtomic(paths.storageState, storageState);
    storageStatePath = path.relative(root, paths.storageState);
  }

  const repro = compile(trace, {
    name: options.name,
    storageStatePath,
    observed,
    setup,
    ...(session?.proven ? { sessionCheck: { step: session.step } } : {}),
  });

  // Written before any error is raised: a driver that failed on step 12 still
  // captured eleven real steps, and throwing them away wastes the whole run.
  await writeRepro(repro, paths);

  if (driveError) throw new PartialRecordingError(driveError, paths.ir, repro);
  return { repro, irPath: paths.ir, stopReason, session, warnings };
}

export interface RunReproOptions extends RunOptions {
  name: string;
  /** Directory of shared setup steps. Defaults to `.repros/steps`, like `record`. */
  stepsDir?: string | null;
}

export interface WarmSession {
  context: import('playwright').BrowserContext;
  page: import('playwright').Page;
  close(): Promise<void>;
}

/**
 * A browser held open across replays.
 *
 * A fresh context boots the app from a cold cache every time, which on a heavy
 * single-page app costs several times the replay itself. Holding one open keeps
 * the HTTP and V8 caches warm — measured at 81% off page load even on a trivial
 * app, and the gap widens with the size of the bundle.
 *
 * It trades isolation for speed, so it belongs in a fix-verify loop a person is
 * watching, not in a verification that has to stand on its own.
 */
export async function openSession(options: {
  name: string;
  root?: string;
  headed?: boolean;
  /**
   * Retarget the captured session onto another deployment before seeding —
   * same meaning as `RunOptions.envUrl`. Without it a warm session for
   * `--env` opened with the recorded origin's cookies and replayed signed out.
   */
  envUrl?: string | null;
  /** Hold the session in a persistent Chromium profile instead of a seeded fresh context. */
  profileDir?: string | null;
  /**
   * Open the context inside an already-running browser (e.g. a BrowserPool's).
   * `close()` then closes only the context and leaves the browser alive.
   */
  browser?: import('playwright').Browser | null;
}): Promise<WarmSession> {
  const root = options.root ?? process.cwd();
  const repro = await readRepro(options.name, root);
  const seed = resolveSessionSeed(repro, root, options);
  const opened = await openBrowser({
    headless: !options.headed,
    viewport: repro.viewport,
    storageStatePath: seed.storageStatePath,
    storageState: seed.storageState,
    profileDir: options.profileDir ?? null,
    // A persistent profile owns its own process, so it cannot share one.
    browser: options.profileDir ? null : (options.browser ?? null),
  });
  return { context: opened.context, page: opened.page, close: opened.close };
}

/** Replay a recorded repro. Reads and validates the IR, then drives the browser. */
export async function run(options: RunReproOptions): Promise<RunResult> {
  const root = options.root ?? process.cwd();
  const repro = await readRepro(options.name, root);
  const { steps, errors } = repro.setup.length
    ? await loadSteps(options.stepsDir ?? path.join(root, STEPS_DIR))
    : { steps: new Map<string, LoadedStep>(), errors: [] as { file: string; message: string }[] };
  for (const e of errors) {
    process.stderr.write(`warning: shared step ${e.file} could not be loaded — ${e.message}\n`);
  }
  const result = await runRepro(repro, {
    ...options,
    steps: options.steps ?? steps,
    stepErrors: errors,
  });

  await writeLastResult(reproPaths(options.name, root), {
    status: result.passed ? 'pass' : 'fail',
    at: new Date().toISOString(),
    durationMs: result.durationMs,
    ...(result.failure ? { failedStepId: result.failure.stepId } : {}),
  });

  return result;
}

/** Every repro in `.repros/`, newest first. Never throws on a corrupt IR. */
export async function list(root = process.cwd()): Promise<ReproSummary[]> {
  return listRepros(root);
}

export { assertRepro, fixRepro, type AssertOptions, type FixOptions } from './ir/edit.js';
export {
  applyExtract,
  extractionNudge,
  renderStepModule,
  suggestExtractions,
  type ApplyExtractOptions,
  type ExistingStepMatch,
  type ExtractReport,
  type ExtractSuggestion,
  type SuggestExtractOptions,
} from './extract.js';
export {
  applyExtraction,
  findCommonPrefixes,
  stepKey,
  type ExtractApplyResult,
  type FindCommonPrefixOptions,
  type PrefixCandidate,
} from './ir/extract.js';
export { createReplayServer, createServer } from './mcp/server.js';
export { BrowserPool } from './browser.js';
export {
  defineStep,
  loadSteps,
  runStep,
  StepError,
  STEPS_DIR,
  type LoadedStep,
  type StepDefinition,
} from './steps.js';
export { replayFragment, type ReplayFragmentOptions } from './replayer/fragment.js';
export { defineDrive, loadDrive, type DriveDefinition } from './drive.js';
export { describeSession, type SessionOutcome, type SessionStatus } from './sessions.js';
export { STOP_HOTKEY };
export type { DriveApi } from './recorder/launch.js';
export { deleteRepro, readRepro, reproPaths } from './ir/io.js';
export { compile } from './compiler/compile.js';
export * from './ir/schema.js';
export type { RunResult, StepTiming, RunFailure } from './replayer/run.js';
export type { ReproSummary } from './ir/io.js';
