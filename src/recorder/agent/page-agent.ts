import { installCapture } from './capture.js';
import { AGENT_READY_FLAG, type AgentConfig } from './config.js';
import { observeDomReactions } from './dom-reaction.js';
import { createRevealTracker } from './reveal-tracker.js';
import { createTransport } from './transport.js';

const INSTALLED_FLAG = '__replayAgentInstalled';

/**
 * The in-page capture agent.
 *
 * Bundled by `scripts/build-agent.ts` into a standalone IIFE and injected as
 * source text. It is ordinary module code — it may import freely.
 *
 * Only the top frame records. Selectors generated in a subframe would not
 * resolve against the main frame at replay time, and Phase 0 has no frame
 * addressing in the IR.
 */
export function pageAgent(config: AgentConfig): void {
  const globals = window as unknown as Record<string, unknown>;
  if (globals[INSTALLED_FLAG]) return;
  if (window.top !== window) return;
  globals[INSTALLED_FLAG] = true;

  const transport = createTransport(config);
  // Shared by both halves: the observer reports what appeared, the capture
  // listeners report hovers and actions, and this decides when a hover mattered.
  const reveals = createRevealTracker(config);

  observeDomReactions({ config, transport, reveals });
  installCapture({ config, transport, reveals });

  // Last line on purpose: reaching it proves every listener above installed.
  // A recording that silently captures nothing is the worst failure this tool
  // could have, so the host asserts on this flag.
  globals[AGENT_READY_FLAG] = true;
}
