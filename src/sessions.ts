import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { captureStorageState } from './browser.js';
import { REPROS_DIR, writeFileAtomic } from './ir/io.js';
import type { Repro } from './ir/schema.js';
import { storageStateHasContent, type StorageState } from './replayer/retarget.js';
import { runStep, transitiveRequires, type LoadedStep } from './steps.js';

/**
 * Project sessions.
 *
 * A session belongs to the project and the account, not to the repro. A step
 * marked `establishesSession` produces one, every repro that walks through the
 * step shares it, and it is re-established only when it dies. Ten issues cost
 * one sign-in plus one more per expiry, instead of one per recording.
 *
 * Nothing here probes a session without proof. A probe on a start path where
 * the step's `ensures` is never visible would wait the full timeout and then
 * sign in, on every run, which is the failure this module exists to remove.
 * Proof is recorded per start path in the meta sidecar, and replay only
 * probes a repro that carries `sessionCheck`.
 */

export const SESSIONS_DIR = path.join(REPROS_DIR, 'sessions');

/** Step name, plus a short hash of the explicit params so two accounts never share a file. */
export function sessionKey(step: string, params: Record<string, string> = {}): string {
  const entries = Object.entries(params).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return step;
  const hash = createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 6);
  return `${step}.${hash}`;
}

/** `host:port` is not a legal file name on Windows, so the colon is written as an underscore. */
export function hostSlug(url: string): string {
  return new URL(url).host.replace(/:/g, '_');
}

export interface SessionFiles {
  /** A raw Playwright storage state, usable with --storage-state by hand. */
  state: string;
  /** The sidecar with what the tool learned about it. Null for a per-repro state file. */
  meta: string | null;
}

export function sessionFiles(root: string, key: string, host: string): SessionFiles {
  const base = path.join(root, SESSIONS_DIR, `${key}@${host}`);
  return { state: `${base}.json`, meta: `${base}.meta.json` };
}

/** Inverse of `sessionFiles` for any path; null for a path that is not a project session file. */
export function parseSessionPath(statePath: string): { key: string; host: string } | null {
  const name = path.basename(statePath);
  if (path.basename(path.dirname(statePath)) !== 'sessions') return null;
  if (!name.endsWith('.json') || name.endsWith('.meta.json')) return null;
  const at = name.lastIndexOf('@');
  if (at < 1) return null;
  return { key: name.slice(0, at), host: name.slice(at + 1, -'.json'.length) };
}

export interface SessionMeta {
  mintedAt: string;
  /** Start paths on which the step's `ensures` was seen right after a real sign-in. */
  provenPaths: string[];
}

const EMPTY_META: SessionMeta = { mintedAt: '', provenPaths: [] };

export function readMeta(file: string | null): SessionMeta {
  if (!file || !existsSync(file)) return { ...EMPTY_META, provenPaths: [] };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<SessionMeta>;
    return {
      mintedAt: typeof raw.mintedAt === 'string' ? raw.mintedAt : '',
      provenPaths: Array.isArray(raw.provenPaths) ? raw.provenPaths.filter((p) => typeof p === 'string') : [],
    };
  } catch {
    return { ...EMPTY_META, provenPaths: [] };
  }
}

/** The stored state, or null when the file is missing, corrupt, or holds no session. */
export function readSessionState(file: string): StorageState | null {
  if (!existsSync(file)) return null;
  try {
    const state = JSON.parse(readFileSync(file, 'utf8')) as StorageState;
    return storageStateHasContent(state) ? state : null;
  } catch {
    return null;
  }
}

/**
 * Write the captured state and update the proof for one start path.
 *
 * A path that stopped proving is removed, so the next recording on it signs in
 * for real instead of probing a selector that is no longer there.
 */
export async function persistSession(
  files: SessionFiles,
  state: string,
  proof: { path: string; proven: boolean },
): Promise<void> {
  // A live session token, readable by the owner only; the sidecar holds no secret.
  await writeFileAtomic(files.state, state, 0o600);
  if (!files.meta) return;
  const current = readMeta(files.meta);
  const provenPaths = proof.proven
    ? current.provenPaths.includes(proof.path)
      ? current.provenPaths
      : [...current.provenPaths, proof.path]
    : current.provenPaths.filter((p) => p !== proof.path);
  const meta: SessionMeta = { mintedAt: new Date().toISOString(), provenPaths };
  await writeFileAtomic(files.meta, `${JSON.stringify(meta, null, 2)}\n`);
}

export interface SessionTarget {
  step: LoadedStep;
  params: Record<string, string>;
  key: string;
  host: string;
  files: SessionFiles;
}

export interface SessionPlan {
  /** Null when this recording does not share a session. */
  target: SessionTarget | null;
  /** Seed the context from this file before the browser opens. */
  seedPath: string | null;
  /** The start path is proven for this session, so a seeded context may be probed. */
  probe: boolean;
  /** Why sharing is off, for the record output. Null when it is on. */
  disabled: string | null;
}

function sessionStepsIn(
  setup: { step: string }[],
  steps: Map<string, LoadedStep>,
): LoadedStep[] {
  return Array.from(transitiveRequires(setup.map((s) => s.step), steps))
    .map((name) => steps.get(name))
    .filter((s): s is LoadedStep => Boolean(s?.establishesSession));
}

/**
 * Decide, before the browser opens, whether a recording seeds a stored session.
 *
 * Playwright can only seed a session when the context is created, so this has
 * to run from the declared setup rather than from whatever `drive` ends up
 * calling. An unproven start path is never probed: signing in for real costs
 * one sign-in, a failed probe costs the full timeout and then the sign-in.
 */
export function planSession(o: {
  root: string;
  baseUrl: string;
  startPath: string;
  setup: { step: string; params?: Record<string, string> }[];
  steps: Map<string, LoadedStep>;
  explicitSeed: 'storage-state' | 'profile' | null;
}): SessionPlan {
  const none = { target: null, seedPath: null, probe: false };
  const sessionSteps = sessionStepsIn(o.setup, o.steps);
  if (!sessionSteps.length) return { ...none, disabled: null };
  if (o.explicitSeed) {
    return { ...none, disabled: `--${o.explicitSeed} was given, so the declared session step is not shared` };
  }
  if (sessionSteps.length > 1) {
    return {
      ...none,
      disabled:
        `two session steps in one setup (${sessionSteps.map((s) => s.name).join(', ')}); ` +
        'a single seeded state cannot represent two accounts',
    };
  }
  const step = sessionSteps[0]!;
  if (!step.ensures) {
    return { ...none, disabled: `step "${step.name}" has no ensures, so a stored session cannot be checked` };
  }
  const params = o.setup.find((s) => s.step === step.name)?.params ?? {};
  const key = sessionKey(step.name, params);
  const host = hostSlug(o.baseUrl);
  const files = sessionFiles(o.root, key, host);
  const stored = readSessionState(files.state) !== null;
  const probe = stored && readMeta(files.meta).provenPaths.includes(o.startPath);
  return { target: { step, params, key, host, files }, seedPath: probe ? files.state : null, probe, disabled: null };
}

export type SessionStatus = 'reused' | 'established' | 're-established';

/** What a recording ends up sharing, for the IR and for whoever is reading the output. */
export interface SessionOutcome {
  step: string;
  key: string;
  host: string;
  status: SessionStatus;
  /** The step's ensures was visible on the start path, so the repro may carry sessionCheck. */
  proven: boolean;
  /** Absolute path of the shared state file the repro should point at. */
  statePath: string;
}

/** Whether the step's `ensures` is visible on the current page, within the step's own budget. */
export async function ensuresVisible(page: Page, step: LoadedStep): Promise<boolean> {
  if (!step.ensures) return false;
  try {
    await page
      .locator(step.ensures)
      .first()
      .waitFor({ state: 'visible', timeout: step.ensuresTimeoutMs ?? 30_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Trust a seeded session if it proves alive, otherwise sign in for real, and
 * record whether the start path proves.
 *
 * One routine for record and replay, so the probe and the heal cannot
 * diverge. `probe` is only ever true when the caller holds proof for this
 * start path; a probe without proof would time out and sign in every time.
 */
export async function establishSession(o: {
  page: Page;
  context: BrowserContext;
  steps: Map<string, LoadedStep>;
  ran: Set<string>;
  target: SessionTarget;
  startUrl: string;
  startPath: string;
  probe: boolean;
  /** Write the state and proof back. Off under a persistent profile, which holds its own session. */
  persist: boolean;
}): Promise<{ status: SessionStatus; proven: boolean }> {
  const { step } = o.target;
  if (o.probe && (await ensuresVisible(o.page, step))) {
    o.ran.add(step.name);
    return { status: 'reused', proven: true };
  }
  // Replay marks a restored session's steps as run before getting here, and
  // runStep returns early for anything in that set.
  o.ran.delete(step.name);
  await runStep(step.name, o.page, o.steps, o.ran, o.target.params);
  const state = await captureStorageState(o.context);
  await o.page.goto(o.startUrl, { waitUntil: 'domcontentloaded' });
  const proven = await ensuresVisible(o.page, step);
  if (o.persist) await persistSession(o.target.files, state, { path: o.startPath, proven });
  return { status: o.probe ? 're-established' : 'established', proven };
}

/** The outcome of reading a repro's `sessionCheck`, so replay can refuse by name. */
export type SessionCheckResult =
  | { status: 'none' }
  | { status: 'target'; target: SessionTarget }
  | { status: 'refuse'; step: string };

/**
 * What replay verifies, for a repro carrying `sessionCheck`.
 *
 * The key comes from the file the repro points at, so a hand-edited or
 * retargeted path still resolves. The host is the one replay is driving, so a
 * heal under --env writes the target host's file and leaves the recorded
 * host's alone. A per-repro state file keeps its own path and has no sidecar.
 *
 * A check naming anything but a session step with `ensures` is refused rather
 * than ignored: a probe that happens to pass on the start path would mark an
 * ordinary setup step as already run, and the repro would replay without the
 * effect that step exists to produce.
 */
export function replaySessionTarget(o: {
  repro: Repro;
  root: string;
  baseUrl: string;
  steps: Map<string, LoadedStep>;
}): SessionCheckResult {
  const check = o.repro.sessionCheck;
  if (!check || !o.repro.storageStatePath) return { status: 'none' };
  const step = o.steps.get(check.step);
  if (!step?.establishesSession || !step.ensures) return { status: 'refuse', step: check.step };
  const params = o.repro.setup.find((s) => s.step === step.name)?.params ?? {};
  const host = hostSlug(o.baseUrl);
  const parsed = parseSessionPath(o.repro.storageStatePath);
  const key = parsed?.key ?? sessionKey(step.name, params);
  const files: SessionFiles = parsed
    ? sessionFiles(o.root, key, host)
    : { state: path.resolve(o.root, o.repro.storageStatePath), meta: null };
  return { status: 'target', target: { step, params, key, host, files } };
}

/**
 * May a replay heal write the session it just minted back to disk?
 *
 * `storageStatePath` is a bare string in a hand-editable IR, so the write
 * target is confined to the project's own `.repros/`. Under --env the file a
 * per-repro state path names belongs to the recorded origin, and filling it
 * with the target host's cookies would silently break the recorded one.
 */
export function canPersistHeal(o: {
  files: SessionFiles;
  root: string;
  envUrl?: string | null;
  profileDir?: string | null;
}): { ok: true } | { ok: false; reason: string } {
  if (o.profileDir) return { ok: false, reason: 'the persistent profile holds its own session' };
  const relative = path.relative(path.join(o.root, REPROS_DIR), o.files.state);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, reason: `${path.relative(o.root, o.files.state)} is outside ${REPROS_DIR}/` };
  }
  if (o.envUrl && !o.files.meta) {
    return { ok: false, reason: "--env would overwrite this repro's own state file" };
  }
  return { ok: true };
}

/**
 * One line for the record output, shared by the CLI and the MCP server.
 *
 * `declared` says the recording declared setup, which separates "there was no
 * session step to share" from "there was one and sharing is off", the second of
 * which is explained by a warning printed just above this line.
 */
export function describeSession(
  outcome: SessionOutcome | null,
  o: { declared: boolean } = { declared: false },
): string {
  if (!outcome) return o.declared ? 'not shared (see warning above)' : 'none (no session step declared)';
  const where = `step "${outcome.step}"`;
  switch (outcome.status) {
    case 'reused':
      return `reused the stored session for ${where}, no sign-in`;
    case 'established':
      return `signed in via ${where} and stored the session for later recordings`;
    case 're-established':
      return `stored session for ${where} had expired; signed in again and replaced it`;
  }
}
