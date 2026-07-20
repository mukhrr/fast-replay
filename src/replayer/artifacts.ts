import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import { writeFileAtomic, type ReproPaths } from '../ir/io.js';
import type { RawConsoleEvent, RawNetworkEvent } from '../recorder/types.js';

const CONSOLE_TAIL = 50;

export interface FailureContext {
  stepId: string;
  stepIndex: number;
  semantic: string;
  expected: string;
  observed: string;
  /** Only network activity since the previous step, so the log stays readable. */
  networkSince: RawNetworkEvent[];
  consoleErrors: RawConsoleEvent[];
}

export interface WrittenArtifacts {
  dir: string;
  screenshot: string | null;
  consoleLog: string;
  networkLog: string;
  summary: string;
}

/**
 * Everything a human (or an agent reading the MCP response) needs to understand
 * a failure without re-running anything.
 */
export async function writeFailureArtifacts(
  page: Page | null,
  paths: ReproPaths,
  failure: FailureContext,
): Promise<WrittenArtifacts> {
  // Stale artifacts from an earlier run are worse than none.
  await rm(paths.artifactsDir, { recursive: true, force: true });
  await mkdir(paths.artifactsDir, { recursive: true });

  const screenshot = path.join(paths.artifactsDir, 'screenshot.png');
  let screenshotPath: string | null = null;
  if (page && !page.isClosed()) {
    try {
      await page.screenshot({ path: screenshot, fullPage: true });
      screenshotPath = screenshot;
    } catch {
      // A crashed or navigating page cannot be captured; the rest still helps.
    }
  }

  const consoleLog = path.join(paths.artifactsDir, 'console.log');
  const tail = failure.consoleErrors.slice(-CONSOLE_TAIL);
  await writeFileAtomic(
    consoleLog,
    tail.length
      ? `${tail.map((c) => `[${new Date(c.t).toISOString()}] ${c.text}`).join('\n')}\n`
      : 'No console errors captured.\n',
  );

  const networkLog = path.join(paths.artifactsDir, 'network.log');
  await writeFileAtomic(
    networkLog,
    failure.networkSince.length
      ? `${failure.networkSince
          .map((n) => {
            const status = n.failed ? `FAILED(${n.status ?? 'aborted'})` : (n.status ?? 'pending');
            const ms = n.settledAt ? `${n.settledAt - n.startedAt}ms` : 'in-flight';
            return `${n.method} ${n.url} -> ${status} (${ms})`;
          })
          .join('\n')}\n`
      : 'No network activity since the previous step.\n',
  );

  const summary = path.join(paths.artifactsDir, 'failure.json');
  await writeFileAtomic(
    summary,
    `${JSON.stringify(
      {
        stepId: failure.stepId,
        stepIndex: failure.stepIndex,
        semantic: failure.semantic,
        expected: failure.expected,
        observed: failure.observed,
        screenshot: screenshotPath,
        consoleLog,
        networkLog,
      },
      null,
      2,
    )}\n`,
  );

  return {
    dir: paths.artifactsDir,
    screenshot: screenshotPath,
    consoleLog,
    networkLog,
    summary,
  };
}
