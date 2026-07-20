import { INSTALL_GLOBAL, type AgentConfig } from './config.js';
import { pageAgent } from './page-agent.js';

/**
 * Bundle entry point. esbuild compiles this and everything it imports into a
 * single IIFE, which is injected into the page as source text.
 *
 * The bundle only *publishes* the installer — it does not run it. Config is
 * applied by a short call appended after the bundle, so the bundle itself is a
 * fixed, cacheable string.
 */
(window as unknown as Record<string, unknown>)[INSTALL_GLOBAL] = (config: AgentConfig): void => {
  pageAgent(config);
};
