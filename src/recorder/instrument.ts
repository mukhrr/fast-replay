import { AGENT_BUNDLE } from './agent-bundle.generated.js';
import { INSTALL_GLOBAL, type AgentConfig } from './agent/config.js';

export {
  AGENT_READY_FLAG,
  DEFAULT_AGENT_CONFIG,
  FLUSH_GLOBAL,
  INSTALL_GLOBAL,
  type AgentConfig,
} from './agent/config.js';

/**
 * The exact source injected into the page: the prebuilt agent bundle, then a
 * call applying this session's config.
 *
 * Wrapped as one expression so it is valid both as an init-script body and as
 * an `evaluate` argument.
 *
 * Note what this deliberately is *not*: it does not serialize a live function
 * with `Function.prototype.toString()`. That coupled what ran in the browser to
 * whichever transform compiled the host, and esbuild's `keepNames` silently
 * broke it — the agent threw immediately and every recording came back empty
 * while the tests passed. The bundle is built once, by one toolchain, and
 * verified at build time.
 */
export function agentSource(config: AgentConfig): string {
  return `(function () {
${AGENT_BUNDLE}
window[${JSON.stringify(INSTALL_GLOBAL)}](${JSON.stringify(config)});
})()`;
}
