# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

fast-replay records a browser bug once (via Playwright) and replays it deterministically in seconds, with no model in the loop. Recordings ("repros") are disposable JSON IR in `.repros/`, meant to be deleted once the bug is fixed. Ships as a CLI (`repro`), an MCP server (`repro-mcp`), and a programmatic API.

## Commands

```bash
npm test                          # full suite: unit + real-browser integration
npx vitest run tests/steps.test.ts   # single test file
npx vitest run -t "name"          # single test by name
npm run typecheck                 # tsc --noEmit
npm run build                     # compile to dist/ (also regenerates agent bundle)
npm run build:agent               # regenerate src/recorder/agent-bundle.generated.ts
npm run stress                    # record once, replay 20x, fail on a single flake
npm run demo                      # run examples/demo-app (Vite)
```

One-time setup before tests: `npx playwright install chromium` and `npm ci --prefix examples/demo-app` — integration tests record/replay against the demo app with a real Chromium, so its dependencies are part of the test fixture.

Tests run with `fileParallelism: false` (they share ports and `.repros/` scratch dirs) and 120s timeouts. CI runs typecheck + tests on Node 20 and 22.

## Architecture

The pipeline is **record → compile → IR → replay**, with three thin surfaces on top:

- `src/api.ts` — the real entry point (`record`, `run`, `list`, `openSession`). The CLI and MCP server are both thin wrappers over it.
- `src/cli/` — the `repro` binary (commander).
- `src/mcp/` — the `repro-mcp` server; returns verdict, failing step, console/network, and the screenshot as an inline image in one call.

**Recorder** (`src/recorder/`): launches/attaches to a Playwright Chromium context and injects an in-page capture agent. The agent (`src/recorder/agent/`) runs **inside the browser page** — it captures actions, derives the selector ladder (test id → name → ARIA role+name → labelled ancestor → stable CSS → text) and semantic descriptions, all rule-based. It is bundled by esbuild into `src/recorder/agent-bundle.generated.ts` via `scripts/build-agent.ts`; never edit the generated file. `keepNames` is deliberately off (esbuild's `__name` helpers don't exist in page scope and would silently break capture); a freshness test fails if the bundle goes stale, and `pretest`/`prebuild` hooks regenerate it.

**Compiler** (`src/compiler/`): turns the raw event trace into IR steps — merges gestures (dblclick, key-activation-synthesized clicks), attributes navigations to their causing action, and derives `waitAfter` from reactions the recording actually observed (network settling, DOM appearing/vanishing). Replay never sleeps; every wait is an observed signal with a measured timeout.

**IR** (`src/ir/`): the zod schema in `schema.ts` is the source of truth for the on-disk JSON (`.repros/<name>/`), with `IR_VERSION` bumped on non-backward-readable changes. `edit.ts` backs `repro fix` / `repro assert`. Key concepts: `target.identity` (the text that must match before acting — replay verifies it and refuses rather than acts on the wrong element), `assertion.mode` (`expect-bug` vs `expect-fixed`), `observedAtRecord` (the bug's signature: console errors and failed requests, minus per-repro ambient noise via `src/noise.ts`), and `expectedWhenFixed` (hand-written fix criterion; without it `--expect-fixed` refuses rather than passing a check that checked nothing).

**Replayer** (`src/replayer/`): `run.ts` drives the browser from IR. Failure `kind` distinguishes `assertion` (a verdict on the bug) from `infrastructure` (`COULD NOT VERIFY` — the harness couldn't drive the app, which says nothing about the bug). `retarget.ts` implements `--env` (moves goto steps, same-origin network patterns and the session onto a new origin). `values.ts` expands `{{random:*}}` placeholders. Failure artifacts (screenshot, console tail, network log) land in `.repros/<name>/artifacts/`.

**Shared setup steps** (`src/steps.ts`): user-authored functions in `.repros/steps/*.mjs` (`defineStep`), referenced by name in the IR rather than recorded, so fixing the step fixes every repro that uses it. `ensures` is a post-condition selector checked after the step runs; `establishesSession: true` runs the step once at record time and restores the captured session on every replay. A failing step reports `COULD NOT VERIFY` by name, never a verdict on the bug.

## Design principles that constrain changes

- **No model calls anywhere in this tool.** It is the deterministic eye an agent looks through; anything requiring judgement belongs to the caller.
- **Refuse rather than guess.** A confident wrong verdict is the one unacceptable output. When a selector resolves to the wrong element or setup fails, report `COULD NOT VERIFY`, not pass/fail.
- **The IR is hand-editable JSON, not generated code.** Keep it readable; the replayer stays dumb (tries selector candidates in order, never rewrites them).
- Comments in this codebase state design rationale — why a constant has its value, what failure a guard prevents. Match that idiom.

## Testing conventions

`tests/helpers/demo-server.ts` boots the demo app's Vite binary directly (not via npm, to avoid orphaned processes holding the port); `tests/helpers/flow.ts` is the scripted 10-step stand-in for a human clicking through the demo bug, deliberately waiting for the UI to settle between actions so the recorder sees real reaction windows. Integration tests record and replay for real — expect them to be slow and browser-dependent.
