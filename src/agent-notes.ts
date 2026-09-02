import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { age } from './cli/format.js';
import { extractionNudge } from './extract.js';
import { listRepros, readRepro } from './ir/io.js';
import { parseSessionPath, readMeta, SESSIONS_DIR } from './sessions.js';
import { loadSteps, STEPS_DIR } from './steps.js';

/**
 * What an agent should know before its first tool call.
 *
 * Sent as the MCP server's `instructions` and printed by `repro init` for
 * CLAUDE.md, from one string so the two cannot drift. The snapshot is names
 * and one-line descriptions only, never IR bodies: it has to fit in the
 * agent's context beside the actual issue.
 */

export const MCP_CONFIG_SNIPPET =
  '{ "mcpServers": { "replay": { "command": "npx", "args": ["repro-mcp"] } } }';

export const AGENT_WORKFLOW = `fast-replay records a browser bug once and replays it deterministically in seconds, with no model in the loop. Use it instead of driving the browser step by step through every verification.

Workflow for one issue:
1. repro_steps: see the shared setup steps this project already has (sign-in, navigation to a screen). Reuse them; write a new one under .repros/steps/ only when nothing reaches the state you need.
2. Write a drive file at .repros/drive/<name>.mjs:
     import { defineDrive } from 'fast-replay';
     export default defineDrive({
       setup: [{ step: 'signed-in' }],
       async drive(page, { step, observe }) { /* Playwright to the bug; observe('<selector>') names the evidence while it is on screen */ },
     });
   then call repro_record. Declare the sign-in step in setup so the project's stored session is reused instead of signing in again.
3. Fix the code, then repro_run with expect_fixed=true after every change. BUG FIXED means done. COULD NOT VERIFY means the harness could not drive the app and says nothing about the bug; read the failing step before touching the fix.
4. When repro_list or repro_record says several repros share a prefix, repro_extract turns it into a shared step so the next issue starts faster. You name the step.
5. repro_delete once the fix is confirmed. Repros are disposable; steps, config and sessions stay.`;

interface StoredSession {
  key: string;
  host: string;
  age: string;
}

async function storedSessions(root: string): Promise<StoredSession[]> {
  const dir = path.join(root, SESSIONS_DIR);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const found: StoredSession[] = [];
  for (const entry of entries) {
    const parsed = parseSessionPath(path.join(dir, entry));
    if (!parsed) continue;
    const meta = readMeta(path.join(dir, entry.replace(/\.json$/, '.meta.json')));
    const minted = meta.mintedAt || (await stat(path.join(dir, entry))).mtime.toISOString();
    found.push({ key: parsed.key, host: parsed.host, age: age(minted) });
  }
  return found;
}

/** Steps, stored sessions, repros, origins and pending extractions, as a few lines. */
export async function renderProjectSnapshot(root: string): Promise<string> {
  const lines: string[] = ['This project right now:'];

  const { steps, errors } = await loadSteps(path.join(root, STEPS_DIR));
  const sessions = await storedSessions(root);
  lines.push(`Shared steps (${steps.size}):`);
  if (!steps.size) lines.push('  none yet');
  for (const s of steps.values()) {
    const tags = [
      s.establishesSession ? 'session' : null,
      s.requires?.length ? `requires: ${s.requires.join(', ')}` : null,
      s.ensures ? null : 'verifies nothing',
    ].filter((t): t is string => Boolean(t));
    lines.push(`  ${s.name} — ${s.description}${tags.length ? ` [${tags.join('; ')}]` : ''}`);
    const stored = sessions.filter((x) => x.key === s.name || x.key.startsWith(`${s.name}.`));
    if (stored.length) {
      lines.push(`    stored session: ${stored.map((x) => `${x.host} (${x.age} old)`).join(', ')}`);
    }
  }
  for (const e of errors) lines.push(`  ${e.file} could not be loaded: ${e.message}`);

  const repros = await listRepros(root);
  lines.push(`Repros (${repros.length}):`);
  if (!repros.length) lines.push('  none yet');
  const origins = new Set<string>();
  for (const r of repros) {
    const last = r.lastResult ? `${r.lastResult.status} ${age(r.lastResult.at)} ago` : 'never run';
    lines.push(`  ${r.name} — ${r.steps ?? '?'} steps, last run: ${last}${r.error ? ` (INVALID: ${r.error})` : ''}`);
    if (r.error) continue;
    try {
      origins.add(new URL((await readRepro(r.name, root)).baseUrl).origin);
    } catch {
      // Already reported through r.error on the next listing.
    }
  }
  if (origins.size) lines.push(`Recorded against: ${Array.from(origins).join(', ')}`);

  try {
    lines.push(...(await extractionNudge(root)));
  } catch (err) {
    // A broken config must not take the server down with it.
    lines.push((err as Error).message);
  }
  return lines.join('\n');
}

export async function buildInstructions(root: string): Promise<string> {
  return `${AGENT_WORKFLOW}\n\n${await renderProjectSnapshot(root)}`;
}
