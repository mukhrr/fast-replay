# Jev: goal-driven recording, optional

Date: 2026-09-24
Status: approved in discussion, awaiting implementation plan
Release: 1.0.0, no IR version bump

## Why

Recording a bug means someone walks the app to it. A human is slow to start and an LLM agent spends 2 to 10 seconds per step deciding which button comes next. Jev (TypeSafe AI's System One model) returns a typed choice with probabilities in about 0.3 seconds. On the demo app, 6 goals times 3 runs, Jev, Haiku and Sonnet each reached 18 of 18 and refused the impossible goal every time; median decision time was 343 ms for Jev, 1.7 s for Sonnet and 4.3 s for Haiku at the API, and a whole run took 103 s against 312 s and 357 s.

The finding is only useful at record time. Once a path is found it is IR, and replay needs no decisions at all.

## The rule that changes

"No model calls anywhere in this tool" becomes "no model calls at replay". Jev may help find the path while recording. The IR, the replayer and the verdict do not change, and nothing under `src/replayer/` may import `src/jev/`. A repro recorded with Jev replays with no key.

## Without a key

Nothing changes. No network call, no new dependency, no new behaviour except the first-run notice. `--goal` without a key refuses with one line: `--goal needs a TypeSafe key: set TYPESAFE_API_KEY or run repro jev login`.

## Goal-driven recording

### CLI

```
repro record <name> -u <url> --goal "<text>" --until <check> [--input "Label=value"]... [--max-steps 12] [--headed]
```

- `--goal` and `--drive` are mutually exclusive. `--goal` requires `--until`.
- `--until` is checked by code before each step and after the last one. Forms: a CSS selector, `text=<exact visible text>`, `url=<substring of the URL>`.
- `--input` may repeat. The label is the field's `<label>` text, `aria-label` or `placeholder`. Jev can only fill fields named here and only with the value given.
- `--max-steps` defaults to 12.
- Headless unless `--headed`, as with `--drive`.

### Outcomes

| Outcome | Written | Exit | Printed |
|---|---|---|---|
| `--until` holds | the repro, as today | 0 | the normal record summary plus the path Jev took |
| Jev picks none | nothing | 1 | `Jev found no action toward the goal`, the path tried |
| step limit reached | nothing | 1 | `stopped after N steps without reaching --until`, the path tried |
| Jev request failed | nothing | 1 | the error by name, see Failure handling |

A recording that did not reach `--until` is never saved: a repro that never reached the bug would read as fixed.

### API

`RecordOptions.goal?: { goal: string; until: string; inputs?: Record<string, string>; maxSteps?: number }`. `goal` and `drive` are mutually exclusive; `record()` builds the drive function from `goal` and throws `GoalNotReached` carrying the tried path when it is not reached.

### MCP

`repro_record` gets optional `goal`, `until` and `inputs` fields. `drive` becomes optional; exactly one of `drive` and `goal` is required, otherwise the tool refuses naming both. Without a key a `goal` call refuses with the same line as the CLI. The result carries the path taken.

### One step

1. Check `--until`. If it holds, stop: reached.
2. Collect candidates in the page: visible, enabled `button`, `a[href]`, `[role=button|link|menuitem|tab]` with a non-empty accessible name, and `input`, `select`, `textarea` whose label is a key of `inputs` and whose current value differs from it. Up to 200. Held as Playwright element handles; nothing is written to the DOM, because the recorder watches the DOM and a marker attribute could end up in a selector or a wait signal.
3. Ask one Choice question. State: goal, URL path, `h1`/`h2` texts, current field values keyed by label (password fields masked as `********`), status texts (`[role=status]`, `[role=alert]`), and the actions already taken. Options: one per candidate described as `click button "Save"`, `type "x" in the "Title" field`, `choose "x" in the "Sensor" field`, plus `none`.
4. `none` wins: stop, refused. Otherwise act on the most probable option, whatever its confidence. Several fine next actions split the probability; stopping on low confidence refused goals that were going well in the spike.
5. Wait for the page to settle (network idle up to 4 s, then 300 ms), then go to 1.

## Key handling

- Resolution order: `TYPESAFE_API_KEY`, then `~/.config/fast-replay/credentials.json` (`$XDG_CONFIG_HOME` honoured). Never the project directory: `.repros/config.json` is committed.
- `repro jev login` reads the key from a hidden prompt, or stdin when piped, verifies it with one request, and writes the file with mode 0600.
- `repro jev logout` deletes the file.
- `repro jev status` prints where the key comes from (env, file, none), the result of one ping, and the list of what is sent.

## What leaves the machine

Per step, to `api.typesafe.ai`: the goal text, the URL path (no origin, no query), page headings, visible control names, field labels and current values with passwords masked, status texts, and the actions taken so far. Nothing at replay. The README, `repro jev status` and the MCP instructions say so.

## First-run notice

Printed by the CLI before its command output, once per version, when all hold: stdout is a TTY, no key resolves, `FAST_REPLAY_NO_NOTICE` is unset, and `~/.config/fast-replay/state.json` has no `noticeShown` for this version. Then the stamp is written. A write failure is ignored.

```
fast-replay 1.0.0: optional Jev support. repro record --goal "..." finds the path
for you, about 0.3s per step against 2-5s for an LLM. Needs a TypeSafe key:
repro jev login. Everything else works as before without it.
```

No postinstall script: npm 7+ hides its output, pnpm and Yarn 4 skip it, and install scripts are flagged by supply-chain audits. The MCP server adds one line about Jev to its instructions, stating whether a key is set.

## Failure handling

- `401`: refuse naming `repro jev login`; no retry.
- `422`: refuse with the API's message; this is a bug in the request.
- `429` and `529`: retry with backoff 0.5 s, 1 s, 2 s, then refuse.
- Network error or timeout (30 s per request): refuse naming it.
- Every refusal stops the recording and saves nothing.

## Units

| File | Job |
|---|---|
| `src/jev/key.ts` | resolve, save and delete the key |
| `src/jev/client.ts` | one `choice` call over `fetch`, retries, typed errors |
| `src/jev/driver.ts` | `goalDrive(options, client)` returns `drive(page, api)`; `parseUntil` |
| `src/notice.ts` | decide and stamp the first-run notice |
| `src/api.ts` | `RecordOptions.goal`, `GoalNotReached` |
| `src/cli/index.ts` | `record --goal/--until/--input/--max-steps`, `jev login|logout|status`, notice call |
| `src/mcp/server.ts` | `goal`, `until`, `inputs` on `repro_record` |
| `src/agent-notes.ts` | one Jev line in the workflow text |

`client` is passed into `goalDrive` so tests use a scripted fake.

## Testing

- Key: env beats file; file written 0600; missing file resolves to none; `XDG_CONFIG_HOME` honoured.
- Notice: shown once per version; skipped for non-TTY, the env flag, a set key; unwritable state file does not throw.
- Client against a fake `fetch`: request shape, 401 no retry, 529 retried then refused, 422 message passed through.
- `parseUntil` for selector, `text=`, `url=`.
- Integration on the demo app with a scripted fake client: add-sensor reaches `--until` and the saved IR replays with no client; a `none` answer saves nothing; the step limit saves nothing; the IR contains no attribute the driver could have added; a password field is masked in the state the client received.
- Boundary: no file under `src/replayer/` imports `src/jev/`.
- Live: the demo-app goals against the real API, skipped unless `TYPESAFE_API_KEY` is set.

## Release 1.0.0

Version bump, CHANGELOG entry, a few README lines (details stay in the CHANGELOG), the rule change in CLAUDE.md, typecheck and full suite green. Tag `v1.0.0` with message `fast-replay 1.0.0`, push and `npm publish` only after Mukher says yes.

## Out of scope

Replay healing with Jev, Jev choosing values to type, Jev deciding the goal is reached, a postinstall script, storing the key in the project.
