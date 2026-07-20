/**
 * Shared between the bundled in-page agent and the Node side that injects it.
 * Kept in its own module so neither direction pulls in the other's code.
 */

export interface AgentConfig {
  emitBinding: string;
  stopBinding: string;
  scrollDebounceMs: number;
  scrollMinDeltaPx: number;
  /** Cap on selectors harvested from a single mutation record, to bound cost. */
  maxSelectorsPerMutation: number;
  /** A hover only becomes a step if it revealed content this recently. */
  hoverRevealWindowMs: number;
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  emitBinding: '__replayEmit',
  stopBinding: '__replayStop',
  scrollDebounceMs: 150,
  scrollMinDeltaPx: 50,
  maxSelectorsPerMutation: 12,
  hoverRevealWindowMs: 400,
};

/** The bundle exposes the installer here; the injected tail calls it. */
export const INSTALL_GLOBAL = '__replayInstall';

/** Set once every listener is installed; see `verifyInstrumentation`. */
export const AGENT_READY_FLAG = '__replayAgentReady';

/**
 * Settles any pending DOM reaction immediately. The host calls this when the
 * recording stops, so the final action's reaction is not lost to a confirmation
 * timer that would have fired after teardown.
 */
export const FLUSH_GLOBAL = '__replayFlush';
