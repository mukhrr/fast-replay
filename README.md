# fast-replay

[![CI](https://github.com/mukhrr/fast-replay/actions/workflows/ci.yml/badge.svg)](https://github.com/mukhrr/fast-replay/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/fast-replay)](https://www.npmjs.com/package/fast-replay)

Record a browser bug once, replay it in seconds, with no model at replay.

Some bugs sit behind state you can only create once: a transferred workspace, a consumed invite, a migrated account. Getting there costs half an hour. Checking whether your fix worked should not cost it again. Do the irreversible part by hand, record the flow that looks at the result, and you own a few-second check you can run forever.

```
$ repro run sensor-delete-crash

STEP  ACTION  ACT   WAIT   TOTAL  WHAT
s1    fill    26ms  492ms  518ms  New sensor name textbox in the section labelled "Sensors"
s5    click   7ms   25ms   32ms   Delete Sensor 2 button in the row containing "Sensor 2"
s10   click   23ms  1.79s  1.81s  Generate report button

✓ PASS  sensor-delete-crash — 10 steps in 2.84s
```

Repros live in `.repros/` and are disposable. Delete one when its bug is fixed; left behind, it rots against a moving app and becomes a test nobody meant to write.

## Install

```bash
npm install -D fast-replay
npx playwright install chromium
```

Node >= 20.

## Use

```bash
repro init                                                # once per project: ignore rules, config, agent notes
repro record checkout-crash --url http://localhost:3000   # click the bug once
repro run checkout-crash                                  # bug still reproduces?
repro run checkout-crash --expect-fixed                   # did my fix work?
repro watch checkout-crash --expect-fixed                 # keep the browser open, replay on Enter
repro list
repro rm checkout-crash                                   # once it's fixed
```

Stop recording with **Ctrl/Cmd + Shift + X**, or close the browser.

`repro run` answers in terms of the bug: `BUG REPRODUCED` / `BUG DID NOT REPRODUCE`, or with `--expect-fixed`, `BUG FIXED` / `BUG STILL PRESENT`. A run that could not drive the app says `COULD NOT VERIFY` instead of guessing. Exit `0` on pass, `1` on fail. A failure leaves a screenshot, console tail and network log in `.repros/<name>/artifacts/`.

| Flag | |
|---|---|
| `--expect-fixed` | pass when the bug no longer happens |
| `--env <url>` | replay a repro recorded elsewhere against this deployment |
| `--headed` | visible browser; some apps refuse headless |
| `--profile <dir>` | record or replay in a persistent Chromium profile, to reuse a login |
| `--storage-state <file>` | record only: seed cookies and storage from a Playwright state file |
| `--setup <cmd>` | reset state before replaying |
| `--timeout-scale <n>` | multiply recorded waits, for a slower machine |
| `--drive <file>` | record only: drive the recording from a file instead of by hand |

### Record on staging, verify on localhost

```bash
repro record checkout-crash --url https://staging.example.com
# fix the code, then:
repro run checkout-crash --env http://localhost:3000 --expect-fixed
```

`--env` moves `goto` steps, the app's own network patterns and the captured session onto the target origin. Sibling hosts such as `api.example.com` move with the app; third-party origins are left alone. `-u` redirects navigation only.

### Repair a recording

```bash
repro fix my-bug --scale-timeouts 3 --min-timeout 8000
repro fix my-bug --relax-network --drop-wait 'role=img[name="Loading..."]'
repro fix my-bug --drop-step s4 --add-candidate 's2=[data-testid="save"]'

repro assert my-bug --fixed --appeared 'text=Total spend'
repro assert my-bug --fixed --focused '[data-testid="opener"]'
```

Every edit prints what it changed. A bug with no console error or failed request needs one of these `assert` lines, or `--expect-fixed` refuses to answer rather than pass a check that checked nothing.

## From a coding agent

```json
{ "mcpServers": { "replay": { "command": "npx", "args": ["repro-mcp"] } } }
```

`repro init` prints that line, sets up `.repros/` (steps and config committed, repros and sessions ignored) and prints a short workflow for CLAUDE.md. The server sends the same workflow, plus the project's steps, sessions and repros, as its `instructions`, so an agent starts informed.

An agent records with a drive file, in one call:

```js
// .repros/drive/checkout-crash.mjs
import { defineDrive } from 'fast-replay';

export default defineDrive({
  setup: [{ step: 'signed-in' }],   // seeded from the stored session, not re-run
  async drive(page, { observe }) {
    await page.click('[data-testid="checkout"]');
    await observe('text=Something went wrong');   // checked now; the recording fails if it does not hold
  },
});
```

`repro_record` runs it headless (`repro record <name> --url <base> --drive <file>` from the CLI). `repro_run` returns the verdict, the failing step, console, network and the page as an inline image, in one call. Between calls the server keeps the browser warm, since one issue means many runs against the same repro; pass `reuse: false` for a verification that must stand alone. Also exposed: `repro_list`, `repro_steps`, `repro_extract`, `repro_artifacts`, `repro_delete`. Works with Claude Code, Codex, Gemini CLI, Cursor.

### Let Jev walk to the bug (optional)

With a [TypeSafe](https://typesafe.ai) key, recording can start from a goal instead of a script:

```bash
repro jev login
repro record report-bug -u http://localhost:5173 \
  --goal "Generate a report titled Weekly rollup" \
  --until '[data-testid="report-result"]' --input "Report title=Weekly rollup"
```

Jev picks each step in about 0.3 s; `--until` is checked by code and nothing is saved unless it holds. Replay never calls a model. Without a key everything works as before. What is sent: `repro jev status`.

## Shared setup steps

The preamble to a bug is the same across most repros: sign in, open a workspace, get to a chat. Write it once:

```ts
// .repros/steps/signed-in.mjs
import { defineStep } from 'fast-replay';

export default defineStep({
  name: 'signed-in',
  description: 'Signed in as the seed account',
  establishesSession: true,                 // runs once per project; the session is stored and restored
  ensures: '[data-testid="account-menu"]',  // checked after it runs; pick something visible on every signed-in page
  async run(page) { /* credentials from process.env */ },
});
```

```ts
drive: async (page, { step, observe }) => {
  await step('signed-in');                          // uses the stored account
  await step('new-account', { plan: 'control' });   // when a bug needs something different
  ...
}
```

Setup is referenced, not recorded. The IR names the step and replay runs the function, so the recording holds only the bug flow and fixing a step fixes every repro that uses it. A step that fails reports `COULD NOT VERIFY` by name, with the file it lives in, never a verdict on the bug. A step can `requires` other steps, and `defaults` keeps the common call empty.

A step marked `establishesSession` signs in once and stores the session under `.repros/sessions/`. Later recordings and every replay restore it and skip the step. When the token expires, replay signs in once more, replaces the stored session and says so. Session files hold tokens and are never committed.

`repro steps` lists what exists, and the MCP server exposes the same list, so an agent checks before writing a fourth sign-in helper.

### Extract a step from existing repros

```bash
repro extract                     # list step sequences repeated across repros; writes nothing
repro extract --apply signed-in   # write .repros/steps/signed-in.mjs, rewrite the matched repros
repro extract --use signed-in     # a new recording re-drove an existing step: convert it instead
```

Matching is structural, with volatile identifiers (row numbers, uuids, tokens) masked, and only a true prefix qualifies because setup replays before recorded steps. A repro that matches only after masking is reported but never rewritten. The generated step embeds its steps as plain IR and replays them through the ordinary machinery; edit selectors in the file like any IR, or replace `run()` with hand-written Playwright when you outgrow the recording. Once a prefix is shared by `extractThreshold` repros (`.repros/config.json`, default 4), `repro record` and `repro list` say so.

## How it works

Replay never sleeps. Every wait is a signal the recording observed, a request settling or an element appearing or vanishing, so a step proceeds the instant the app reacts and timeouts come from what was measured.

The recording is JSON, meant to be read and hand-edited:

```jsonc
{
  "id": "s5",
  "action": "click",
  "target": {
    "candidates": ["role=button[name=\"Delete Sensor 2\"]", "[data-testid=\"sensor-row-2\"] > button"],
    "semantic": "Delete Sensor 2 button in the row containing \"Sensor 2\""
  },
  "waitAfter": {
    "network": [{ "urlPattern": "/api/sensors/*", "method": "DELETE" }],
    "domGone": ["[data-testid=\"sensor-row-2\"]"],
    "timeoutMs": 3000
  }
}
```

Selectors are a ladder: test id, `name`, ARIA role + accessible name, labelled ancestor, stable CSS path, text. Build-generated class names are skipped. Before acting, replay checks the resolved element against what was recorded; if a list gained a row and a positional match landed on the wrong record, the run reports `COULD NOT VERIFY` instead of a verdict. A wrong answer you have no reason to doubt is worse than no answer.

## Results

Measured on one machine, same flow both ways.

| | fast-replay | Playwright MCP |
|---|---|---|
| Per verification | **2.7 s** | ~24–32 s |
| Tool calls | **1** | 3–14 |
| Model calls | **0** | 1 per action |
| Context added | ~120 tokens | ~700–2 000 |

10-step flow: 20/20 consecutive replays, slowest 2.77 s. That is the cost of asking again, not of the whole job; the setup behind a real bug is paid once and the question is paid every time. In a real app it caught a **736–779 ms** window where a total failed to render, a state that heals before a snapshot returns, so a model-in-the-loop tool cannot see it. Two independent first passes with Playwright MCP concluded "no bug" and were wrong.

## Limits

- **If you already have a Playwright suite, keep using it.** This earns its keep for throwaway repros and agent loops, not as a test framework.
- **You still have to get to the bug yourself.** Recording captures the observation; reaching the state it observes is your problem.
- **A bug with no console error or failed request needs a hand-written assertion** (`repro assert`), or `--expect-fixed` refuses to answer.
- **A flow that mutates server state is single-shot.** Use `--setup` to reset, or `{{random}}` / `{{random:label}}` placeholders to make inputs unique.
- Records clicks, right-clicks, typing, selects, key presses, scrolls, hovers, navigation and going offline. Top frame only, no iframes; drag-and-drop and file upload are untested.

## Programmatic

```ts
import { record, run, list } from 'fast-replay';

const result = await run({ name: 'my-bug', expectFixed: true });
if (!result.passed) console.log(result.failure.semantic, result.failure.artifacts.screenshot);
```

The CLI and MCP server are thin wrappers over these.

## Develop

```bash
npm test          # unit + real-browser integration
npm run stress    # records once, replays 20x, fails on a single flake
npm run demo      # examples/demo-app
```

`src/recorder/agent/` runs inside the browser and is bundled by esbuild into `agent-bundle.generated.ts`. `npm run build:agent` regenerates it; a test fails if it goes stale.

MIT.
