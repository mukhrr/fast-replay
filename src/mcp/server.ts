import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { buildInstructions } from '../agent-notes.js';
import {
  applyExtract,
  deleteRepro,
  describeSession,
  extractionNudge,
  list,
  loadDrive,
  openSession,
  parseViewport,
  PartialRecordingError,
  readRepro,
  record,
  reproPaths,
  run,
  suggestExtractions,
  type RecordResult,
  type WarmSession,
} from '../api.js';
import { loadSteps, STEPS_DIR } from '../steps.js';
import { BrowserPool } from '../browser.js';
import { VERSION } from '../version.js';
import type { RunResult } from '../replayer/run.js';

/**
 * Replay as an MCP server: a deterministic eye that a coding agent looks
 * through.
 *
 * Nothing here calls a model. The agent already has one — this exists to hand
 * it what the browser actually did, in one call, in a form it can read *and
 * see*. That is the whole difference from driving a browser through an agent
 * step by step: re-verifying a fix costs one round trip instead of one per
 * action, every time.
 */

/** Screenshots are returned inline, so the model sees the page rather than a path. */
const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;

type Content =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

async function imageContent(file: string | null): Promise<Content[]> {
  if (!file) return [];
  try {
    const bytes = await readFile(file);
    if (bytes.byteLength > MAX_INLINE_IMAGE_BYTES) {
      return [
        {
          type: 'text',
          text: `Screenshot too large to inline (${Math.round(bytes.byteLength / 1024)} kB): ${file}`,
        },
      ];
    }
    return [{ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' }];
  } catch {
    return [];
  }
}

async function tail(file: string | null, lines: number): Promise<string> {
  if (!file) return '';
  try {
    const text = await readFile(file, 'utf8');
    return text.split('\n').slice(-lines).join('\n').trim();
  } catch {
    return '';
  }
}

/** The one-screen summary an agent reads before deciding what to do next. */
function summarize(result: RunResult, expectFixed: boolean): string {
  const mode = expectFixed ? 'expect-fixed' : 'expect-bug';
  const timing = `${result.timings.length}/${result.totalSteps} steps in ${(result.durationMs / 1000).toFixed(2)}s`;
  // Stated in terms of the bug: an agent reading "FAIL" for a successful fix
  // will loop on code that is already correct.
  const head = result.passed
    ? expectFixed
      ? `BUG FIXED — ${result.name}, ${timing}`
      : `BUG REPRODUCED — ${result.name}, ${timing}`
    : expectFixed
      ? `BUG STILL PRESENT — ${result.name} after ${(result.durationMs / 1000).toFixed(2)}s`
      : `BUG DID NOT REPRODUCE — ${result.name} after ${(result.durationMs / 1000).toFixed(2)}s`;

  if (result.passed) {
    return expectFixed
      ? `${head}\nThe flow completed and the recorded bug did not occur.\n` +
        `This repro has done its job — delete it with repro_delete unless the developer wants it kept.`
      : `${head}\nThe recorded outcome still occurs, so the repro itself is sound.`;
  }

  const f = result.failure;
  if (!f) return head;
  if (f.kind === 'infrastructure') {
    return [
      `COULD NOT VERIFY — ${result.name}`,
      '',
      'The replay could not drive the app, so this says nothing about whether the bug is fixed.',
      `Failing step: ${f.stepId} (step ${f.stepIndex + 1} of ${result.totalSteps})`,
      `What it does:  ${f.semantic}`,
      `Observed:      ${f.observed}`,
    ].join('\n');
  }
  return [
    head,
    ``,
    `Failing step: ${f.stepId} (step ${f.stepIndex + 1} of ${result.totalSteps})`,
    `What it does:  ${f.semantic}`,
    `Expected:      ${f.expected}`,
    `Observed:      ${f.observed}`,
  ].join('\n');
}

export interface ReplayServer {
  server: McpServer;
  /** Warm sessions held across calls, keyed by everything that shapes them. Exposed for tests. */
  warmSessions: Map<string, WarmSession>;
  /** Closes the browsers held open across calls. */
  dispose(): Promise<void>;
}

/**
 * Whether `repro_run` keeps the browser warm between calls when the caller
 * does not say. One reported issue means running the same repro many times —
 * confirm, fix, verify, verify again — and a fresh context per call re-paid
 * the app's whole cold boot each time, which read as "the tool starts and
 * ends a session on every check". A verification that must stand on its own
 * passes `reuse: false` explicitly.
 */
const REUSE_DEFAULT = true;

export async function createServer(root = process.cwd()): Promise<McpServer> {
  return (await createReplayServer(root)).server;
}

export async function createReplayServer(root = process.cwd()): Promise<ReplayServer> {
  // Instructions travel in the initialize response, so this is the one moment
  // the project's state can reach the agent before its first tool call.
  const server = new McpServer(
    { name: 'replay', version: VERSION },
    { instructions: await buildInstructions(root) },
  );

  /**
   * One browser, held open for the life of the server.
   *
   * A CLI invocation is one-shot and has nothing to amortise, but this process
   * is long-lived: without a pool every verification launched a fresh Chromium
   * with an empty V8 code cache, so a large app paid its full cold boot on
   * every single call. Each run still gets its own context, so replays stay
   * isolated from one another.
   */
  const pool = new BrowserPool();

  /**
   * Warm sessions, keyed by repro name plus everything else that shapes the
   * context — headed, base_url, env_url, profile_dir. Two calls that differ in
   * any of those must not share a session: a page warmed for one origin handed
   * to a run against another is silent cross-deployment carry-over.
   */
  const warm = new Map<string, WarmSession>();

  const warmKey = (
    name: string,
    o: { headed?: boolean; base_url?: string; env_url?: string; profile_dir?: string },
  ): string =>
    JSON.stringify([name, Boolean(o.headed), o.base_url ?? null, o.env_url ?? null, o.profile_dir ?? null]);

  async function acquireWarm(key: string, open: () => Promise<WarmSession>): Promise<WarmSession> {
    const existing = warm.get(key);
    if (existing) {
      // Revalidate the way BrowserPool.acquire does: a crashed or closed
      // context handed out again fails the run for reasons unrelated to the
      // bug. A persistent context has no browser() — the page check decides.
      const alive = !existing.page.isClosed() && (existing.context.browser()?.isConnected() ?? true);
      if (alive) return existing;
      warm.delete(key);
      await existing.close().catch(() => {});
    }
    const fresh = await open();
    warm.set(key, fresh);
    return fresh;
  }

  server.registerTool(
    'repro_run',
    {
      title: 'Run a bug repro',
      description:
        'Replay a recorded bug reproduction against the running dev server and report what happened. ' +
        'Deterministic and fast (a 10-step flow takes about 3 seconds) — call it after every code change to verify a fix. ' +
        'Returns the pass/fail verdict, the failing step with a plain-language description of what it does, the console tail, ' +
        'the network activity, and a screenshot of the resulting page. ' +
        'Use expect_fixed=true while fixing a bug: it passes when the flow completes and the bug no longer occurs.',
      inputSchema: {
        name: z.string().describe('Name of the repro, as shown by repro_list.'),
        expect_fixed: z
          .boolean()
          .optional()
          .describe(
            'True while verifying a fix: pass when the bug does NOT occur. False (default) asserts the bug still reproduces.',
          ),
        base_url: z.string().optional().describe('Override where to navigate, nothing else.'),
        env_url: z
          .string()
          .optional()
          .describe(
            "Replay against another deployment of the same app: moves goto steps, the app's own network patterns and the captured session onto this origin. Use this to verify a fix locally on a repro recorded against staging or production.",
          ),
        headed: z
          .boolean()
          .optional()
          .describe(
            'Run in a visible browser. Required by apps that refuse headless sessions — without it those replays fail for reasons unrelated to the bug.',
          ),
        profile_dir: z
          .string()
          .optional()
          .describe('Persistent Chromium profile directory, to reuse a login.'),
        setup_command: z
          .string()
          .optional()
          .describe('Shell command run before replay, to reset state the flow mutates.'),
        timeout_scale: z
          .number()
          .optional()
          .describe('Multiply every recorded wait. Raise it when replaying somewhere slower than the machine that recorded.'),
        reuse: z
          .boolean()
          .optional()
          .describe(
            'Keep the browser page open between calls so the app stays booted. This is the DEFAULT: one issue means many runs of the same repro, and re-booting the app each time is the slow part. ' +
              'State carries over between runs, so pass false for a verification that must stand on its own (e.g. a final expect_fixed check). ' +
              'Passing setup_command without reuse also runs fresh; combining setup_command with an explicit reuse: true is an error.',
          ),
      },
    },
    async ({ name, expect_fixed = false, base_url, env_url, headed, profile_dir, setup_command, timeout_scale, reuse }) => {
      if (reuse === true && setup_command) {
        return {
          content: [
            {
              type: 'text',
              text:
                'reuse and setup_command cannot be combined: a warm page holds open the very state setup_command resets. ' +
                'Drop one of them.',
            },
          ],
          isError: true,
          structuredContent: { name, passed: false, conflict: 'reuse+setup_command' },
        };
      }
      // setup_command resets state a warm page would hold open, so unless the
      // caller explicitly asked for reuse it opts the call out of the default.
      const wantWarm = reuse ?? (setup_command ? false : REUSE_DEFAULT);
      let session: WarmSession | null = null;
      if (wantWarm) {
        session = await acquireWarm(warmKey(name, { headed, base_url, env_url, profile_dir }), async () =>
          openSession({
            name,
            root,
            headed: Boolean(headed),
            envUrl: env_url ?? null,
            profileDir: profile_dir ?? null,
            // The warm context lives inside the pooled browser, so holding a
            // session open does not hold a second Chromium open.
            browser: profile_dir ? null : await pool.acquire(!headed),
          }),
        );
      }
      const result = await run({
        name,
        root,
        expectFixed: expect_fixed,
        captureFinalScreenshot: true,
        // A persistent profile owns its own process and cannot share the pool;
        // a warm session already sits inside the pooled browser.
        ...(profile_dir || session ? {} : { browser: await pool.acquire(!headed) }),
        ...(headed ? { headed: true } : {}),
        ...(profile_dir ? { profileDir: profile_dir } : {}),
        ...(setup_command ? { setupCommand: setup_command } : {}),
        ...(timeout_scale ? { timeoutScale: timeout_scale } : {}),
        ...(session ? { session } : {}),
        ...(base_url ? { baseUrl: base_url } : {}),
        ...(env_url ? { envUrl: env_url } : {}),
      });

      const artifacts = result.failure?.artifacts ?? null;
      const consoleTail = await tail(artifacts?.consoleLog ?? null, 50);
      const networkLog = await tail(artifacts?.networkLog ?? null, 40);

      const content: Content[] = [{ type: 'text', text: summarize(result, expect_fixed) }];
      // Notes carry the "this may be single-shot" warning, which is the only
      // signal that a green verdict might mean nothing.
      for (const note of result.notes) content.push({ type: 'text', text: note });
      if (consoleTail) content.push({ type: 'text', text: `Console errors:\n${consoleTail}` });
      if (networkLog) content.push({ type: 'text', text: `Network since last step:\n${networkLog}` });
      content.push(...(await imageContent(result.finalScreenshot)));

      return {
        content,
        isError: !result.passed,
        structuredContent: {
          name: result.name,
          passed: result.passed,
          durationMs: result.durationMs,
          totalSteps: result.totalSteps,
          stepsRun: result.timings.length,
          failure: result.failure
            ? {
                stepId: result.failure.stepId,
                stepIndex: result.failure.stepIndex,
                semantic: result.failure.semantic,
                expected: result.failure.expected,
                observed: result.failure.observed,
              }
            : null,
          failureKind: result.failure?.kind ?? null,
          invariantViolations: result.invariantViolations,
          baseUrl: result.baseUrl,
          screenshot: result.finalScreenshot,
        },
      };
    },
  );

  server.registerTool(
    'repro_record',
    {
      title: 'Record a bug repro from a drive file',
      description:
        'Record a repro by running a drive file: a module exporting defineDrive({ setup, drive }) where drive(page, { step, observe }) ' +
        'walks to the bug with Playwright and observe() names the evidence while it is on screen. ' +
        'Declare the sign-in step in setup so the stored project session is reused instead of signing in again. ' +
        'Write the file at .repros/drive/<name>.mjs, call this once, then verify fixes with repro_run. ' +
        'Returns the steps captured, the bug signature seen while recording, and whether a session was reused.',
      inputSchema: {
        name: z.string().describe('Name for the repro. Letters, digits, dot, dash, underscore.'),
        url: z.string().describe('Base URL of the running app, e.g. http://localhost:3000.'),
        drive: z.string().describe('Path to the drive file, relative to the project root or absolute.'),
        start_path: z.string().optional().describe('Path to start at. Default /.'),
        headed: z.boolean().optional().describe('Record in a visible browser. Default false.'),
        viewport: z.string().optional().describe('WxH, default 1440x900.'),
      },
    },
    async ({ name, url, drive, start_path, headed, viewport }) => {
      const refuse = (message: string) => ({
        content: [{ type: 'text' as const, text: message }],
        isError: true,
        structuredContent: { name, partial: false, error: message },
      });

      let driven: Awaited<ReturnType<typeof loadDrive>>;
      try {
        driven = await loadDrive(path.resolve(root, drive));
      } catch (err) {
        return refuse((err as Error).message);
      }

      const started = Date.now();
      let result: RecordResult | null = null;
      let partial: PartialRecordingError | null = null;
      try {
        result = await record({
          name,
          baseUrl: url,
          root,
          startPath: start_path ?? '/',
          viewport: parseViewport(viewport ?? '1440x900'),
          headless: !headed,
          drive: driven.drive,
          setup: driven.setup,
          browser: await pool.acquire(!headed),
        });
      } catch (err) {
        if (!(err instanceof PartialRecordingError)) return refuse((err as Error).message);
        partial = err;
      }

      const repro = result?.repro ?? partial!.repro;
      const irPath = path.relative(root, result?.irPath ?? partial!.irPath);
      const seconds = ((Date.now() - started) / 1000).toFixed(2);
      const observed = repro.assertion.observedAtRecord;
      const consoleErrors = observed?.consoleErrors ?? [];
      const failedRequests = observed?.failedRequests ?? [];
      const evidence = [
        ...(repro.assertion.finalState.domAppeared ?? []),
        ...(repro.assertion.finalState.domGone ?? []).map((s) => `${s} (absent)`),
      ];
      const stepWord = repro.steps.length === 1 ? 'step' : 'steps';

      const lines = partial
        ? [
            `RECORDING STOPPED EARLY — ${name}, ${repro.steps.length} ${stepWord} kept after ${seconds}s`,
            `Driver error: ${partial.cause.message}`,
            `IR: ${irPath}`,
            'The steps up to the failure are on disk. Fix the drive file and record again under this name, or repro_delete it.',
          ]
        : [
            `RECORDED ${name} — ${repro.steps.length} ${stepWord} in ${seconds}s (stopped: ${result!.stopReason})`,
            `IR: ${irPath}`,
            `Session: ${describeSession(result!.session)}`,
          ];
      for (const warning of result?.warnings ?? []) lines.push(`Note: ${warning}`);
      if (evidence.length) lines.push(`Evidence declared: ${evidence.join(', ')}`);
      if (consoleErrors.length || failedRequests.length) {
        lines.push('The bug, as observed while recording:');
        for (const e of consoleErrors) lines.push(`  console: ${e}`);
        for (const r of failedRequests) lines.push(`  network: ${r.method} ${r.urlPattern} -> ${r.status ?? 'aborted'}`);
      } else if (!partial) {
        lines.push(
          'No bug signature was observed (no console errors, no failed requests), so repro_run with ' +
            `expect_fixed will refuse until a criterion is named: repro assert ${name} --fixed --appeared <selector>.`,
        );
      }
      if (!partial) for (const line of await extractionNudge(root)) lines.push(line);
      if (!partial) lines.push('Next: fix the code, then repro_run with expect_fixed=true after every change.');

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        isError: Boolean(partial),
        structuredContent: {
          name,
          irPath,
          steps: repro.steps.length,
          stopReason: result?.stopReason ?? 'drive-failed',
          observed: { consoleErrors, failedRequests, evidence },
          session: result?.session ? { status: result.session.status, step: result.session.step } : null,
          warnings: result?.warnings ?? [],
          partial: Boolean(partial),
          error: partial?.cause.message ?? null,
        },
      };
    },
  );

  server.registerTool(
    'repro_steps',
    {
      title: 'List shared setup steps',
      description:
        'List the reusable setup steps this project already has — sign-in, navigating to a workspace, and so on — with what state each leaves you in. ' +
        'Check this BEFORE writing new setup code for a repro: reusing an existing step means one place to fix when the app changes, ' +
        'where a fresh copy means every repro breaks separately. Write a new step only when nothing here reaches the state you need.',
      inputSchema: {},
    },
    async () => {
      const { steps, errors } = await loadSteps(path.join(root, STEPS_DIR));
      const lines = Array.from(steps.values()).map(
        (s) =>
          `${s.name} — ${s.description}` +
          (s.requires?.length ? ` (requires: ${s.requires.join(', ')})` : '') +
          (s.ensures
            ? ''
            : s.establishesSession
              ? ' [WARNING: verifies nothing, so a break here surfaces elsewhere and its session cannot be shared]'
              : ' [WARNING: verifies nothing, so a break here surfaces elsewhere]'),
      );
      for (const e of errors) lines.push(`${e.file} — could not be loaded: ${e.message}`);
      return {
        content: [
          {
            type: 'text',
            text: lines.length
              ? lines.join('\n')
              : `No shared steps yet. Add one at ${STEPS_DIR}/<name>.mjs with a default export from defineStep().`,
          },
        ],
        structuredContent: {
          // `run` is a function and `fragment` is replay payload — neither
          // belongs in a listing meant for choosing between steps.
          steps: Array.from(steps.values()).map(({ run, fragment, ...rest }) => rest),
          errors,
        },
      };
    },
  );

  server.registerTool(
    'repro_extract',
    {
      title: 'Extract repeated setup into a shared step',
      description:
        'Find step sequences that repeat at the start of multiple recorded repros — the sign-in, the navigation to the screen — ' +
        'and extract them into one shared setup step, so the next repro references it instead of re-recording it. ' +
        'Call WITHOUT name to see candidates; nothing is written. Call with name to apply one: it writes .repros/steps/<name>.mjs ' +
        'and rewrites the matched repros to reference it. Choosing a candidate and naming the step is your judgement — ' +
        'this tool only does the structural matching. Call it after finishing an issue so the next one starts faster.',
      inputSchema: {
        name: z
          .string()
          .optional()
          .describe('Name for the new shared step. Omit to only list candidates.'),
        candidate: z
          .number()
          .optional()
          .describe('Which candidate to extract — the index from the suggest call. Default 0.'),
        length: z.number().optional().describe('Take only the first N steps of the candidate prefix.'),
        use_existing: z
          .string()
          .optional()
          .describe('Convert matching repros onto this existing extracted step instead of writing a new one.'),
        establishes_session: z
          .boolean()
          .optional()
          .describe(
            "Mark the step establishesSession: it runs once at record time and the captured session is restored on every replay. Only when the preamble's whole effect is the browser session (e.g. sign-in).",
          ),
        description: z.string().optional().describe('What state the step leaves you in.'),
        min_steps: z.number().optional().describe('Shortest prefix worth extracting (default 2).'),
        min_repros: z.number().optional().describe('How many repros must share it (default 2).'),
      },
    },
    async ({ name, candidate, length, use_existing, establishes_session, description, min_steps, min_repros }) => {
      if (!name && !use_existing) {
        const { suggestions, existing } = await suggestExtractions({
          root,
          minSteps: min_steps,
          minRepros: min_repros,
        });
        const lines = suggestions.map(
          (s) =>
            `#${s.index}: ${s.stepCount} steps starting at ${s.startPath}, shared by ${s.repros.join(', ')}` +
            (s.inexactRepros.length
              ? ` (near match, values differ: ${s.inexactRepros.join(', ')})`
              : '') +
            '\n' +
            s.preview.map((p) => `    ${p}`).join('\n'),
        );
        for (const m of existing) {
          for (const r of m.repros) {
            lines.push(
              `${r.name}: its first ${r.length} step(s) re-drive shared step "${m.step}" — convert with use_existing`,
            );
          }
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: lines.length
                ? lines.join('\n')
                : 'No repeated prefix across the recorded repros — nothing to extract.',
            },
          ],
          structuredContent: {
            suggestions: suggestions.map(({ candidate: _full, ...rest }) => rest),
            existing,
          },
        };
      }

      const report = await applyExtract({
        name,
        root,
        candidate,
        length,
        useExisting: use_existing,
        establishesSession: establishes_session,
        description,
        minSteps: min_steps,
        minRepros: min_repros,
      });
      const lines = [
        report.stepFile
          ? `wrote ${report.stepFile}`
          : `converted matching repros onto existing step "${report.stepName}"`,
        ...report.perRepro.map((r) =>
          r.skipped ? `${r.name}: skipped — ${r.skipped}` : `${r.name}: ${r.changes.join('; ')}`,
        ),
        `Future recordings: call step('${report.stepName}') in drive() instead of re-driving this preamble.`,
      ];
      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        structuredContent: {
          stepFile: report.stepFile,
          stepName: report.stepName,
          perRepro: report.perRepro,
        },
      };
    },
  );

  server.registerTool(
    'repro_delete',
    {
      title: 'Delete a bug repro',
      description:
        'Delete a repro and its artifacts once its bug is fixed. Repros are disposable by design: they capture one bug, ' +
        'and left behind they rot against a moving app and become tests nobody meant to write. ' +
        'Call this after repro_run with expect_fixed=true has confirmed the fix, unless the developer asked to keep it.',
      inputSchema: {
        name: z.string().describe('Name of the repro to delete.'),
      },
    },
    async ({ name }) => {
      // A deleted repro's warm session would otherwise hold its context open
      // for the life of the server.
      for (const [key, session] of Array.from(warm)) {
        if ((JSON.parse(key) as unknown[])[0] === name) {
          warm.delete(key);
          await session.close().catch(() => {});
        }
      }
      const existed = await deleteRepro(name, root);
      return {
        content: [
          {
            type: 'text',
            text: existed
              ? `Deleted ${name}, along with its session and artifacts.`
              : `No repro named ${name}.`,
          },
        ],
        structuredContent: { name, deleted: existed },
      };
    },
  );

  server.registerTool(
    'repro_list',
    {
      title: 'List bug repros',
      description:
        'List the recorded bug reproductions available in this project, with step count, age, and how each one last did.',
      inputSchema: {},
    },
    async () => {
      const repros = await list(root);
      if (!repros.length) {
        return {
          content: [
            {
              type: 'text',
              text: 'No repros recorded. A developer creates one with: repro record <name> --url <dev server>',
            },
          ],
          structuredContent: { repros: [] },
        };
      }

      const lines = repros.map((r) => {
        const last = r.lastResult
          ? `${r.lastResult.status}${r.lastResult.failedStepId ? ` at ${r.lastResult.failedStepId}` : ''}`
          : 'never run';
        return `${r.name} — ${r.steps ?? '?'} steps, last run: ${last}${r.error ? ` (INVALID: ${r.error})` : ''}`;
      });

      const nudges = await extractionNudge(root);
      return {
        content: [{ type: 'text', text: [...lines, ...nudges].join('\n') }],
        structuredContent: { repros, nudges },
      };
    },
  );

  server.registerTool(
    'repro_artifacts',
    {
      title: 'Inspect a repro',
      description:
        'Read the steps of a repro and the artifacts from its last failure: the failing step, its description, ' +
        'the console tail, the network log, and the screenshot. Use this to understand a bug without re-running it.',
      inputSchema: {
        name: z.string().describe('Name of the repro.'),
      },
    },
    async ({ name }) => {
      const repro = await readRepro(name, root);
      const paths = reproPaths(name, root);
      const artifactsDir = paths.artifactsDir;

      const steps = repro.steps
        .map((s) => `  ${s.id}  ${s.action.padEnd(8)} ${s.target?.semantic ?? s.value ?? ''}`)
        .join('\n');

      const summaryFile = path.join(artifactsDir, 'failure.json');
      let failure: unknown = null;
      try {
        failure = JSON.parse(await readFile(summaryFile, 'utf8'));
      } catch {
        /* no recorded failure */
      }

      const content: Content[] = [
        {
          type: 'text',
          text: [
            `Repro: ${repro.name}`,
            `Base URL: ${repro.baseUrl}${repro.startPath}`,
            `Assertion mode: ${repro.assertion.mode}`,
            ``,
            `Steps:`,
            steps,
          ].join('\n'),
        },
      ];

      const observed = repro.assertion.observedAtRecord;
      if (observed?.consoleErrors.length || observed?.failedRequests.length) {
        content.push({
          type: 'text',
          text: [
            'The bug, as observed when this repro was recorded:',
            ...observed.consoleErrors.map((e) => `  console: ${e}`),
            ...observed.failedRequests.map(
              (r) => `  network: ${r.method} ${r.urlPattern} -> ${r.status ?? 'aborted'}`,
            ),
          ].join('\n'),
        });
      }

      if (failure) {
        content.push({ type: 'text', text: `Last failure:\n${JSON.stringify(failure, null, 2)}` });
        const consoleTail = await tail(path.join(artifactsDir, 'console.log'), 50);
        if (consoleTail) content.push({ type: 'text', text: `Console:\n${consoleTail}` });
        content.push(...(await imageContent(path.join(artifactsDir, 'screenshot.png'))));
      }

      return {
        content,
        structuredContent: { repro, failure, artifactsDir },
      };
    },
  );

  return {
    server,
    warmSessions: warm,
    dispose: async () => {
      await Promise.all(Array.from(warm.values()).map((s) => s.close().catch(() => {})));
      warm.clear();
      await pool.dispose();
    },
  };
}
