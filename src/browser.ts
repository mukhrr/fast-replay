import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

/**
 * Opening a browser is shared by recording and replay, and both need the same
 * two ways of getting an authenticated session.
 *
 * Session seeding is the single thing that decides whether this tool works on a
 * real app, because every target worth verifying is behind a login:
 *
 * - `storageStatePath` — a portable JSON snapshot. Isolated and deterministic:
 *   every run starts from an identical session. Now includes IndexedDB, without
 *   which offline-first apps (Onyx, Dexie, Firebase Auth) cannot be seeded at
 *   all — their tokens never touch cookies or localStorage.
 *
 * - `profileDir` — a real Chromium profile directory. Everything persists:
 *   IndexedDB, service workers, caches. It also sidesteps non-idempotent signup,
 *   because you never sign up twice. The cost is isolation: state accumulates
 *   across runs, so the tenth replay does not start where the first one did.
 *
 * Prefer storageState for repeatable verification; reach for a profile when the
 * app's auth cannot be captured any other way, or to skip a slow cold boot.
 */
export interface OpenBrowserOptions {
  headless: boolean;
  viewport: { width: number; height: number };
  storageStatePath?: string | null;
  profileDir?: string | null;
}

export interface OpenedBrowser {
  context: BrowserContext;
  page: Page;
  /** True when running against a persistent profile. */
  persistent: boolean;
  close(): Promise<void>;
}

export async function openBrowser(options: OpenBrowserOptions): Promise<OpenedBrowser> {
  const { headless, viewport } = options;

  if (options.profileDir) {
    const context = await chromium.launchPersistentContext(options.profileDir, {
      headless,
      viewport,
    });
    // A persistent context always opens with one page; reuse it so we do not
    // leave a stray about:blank tab behind.
    const page = context.pages()[0] ?? (await context.newPage());
    return {
      context,
      page,
      persistent: true,
      close: async () => {
        await context.close().catch(() => {});
      },
    };
  }

  const browser: Browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    viewport,
    ...(options.storageStatePath ? { storageState: options.storageStatePath } : {}),
  });
  const page = await context.newPage();
  return {
    context,
    page,
    persistent: false,
    close: async () => {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}

/**
 * Snapshot the session, including IndexedDB.
 *
 * Playwright omits IndexedDB by default, which silently produces a state file
 * that looks fine and restores nothing for any app keeping its auth there.
 */
export async function captureStorageState(context: BrowserContext): Promise<string> {
  return JSON.stringify(await context.storageState({ indexedDB: true }));
}
