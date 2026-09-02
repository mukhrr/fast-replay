# Agent workflow: project sessions, agent recording, and knowing the project first

Date: 2026-09-02
Status: approved in discussion, awaiting implementation plan
Release: 0.13.0, no IR version bump

## Why

The tool exists so a coding agent looks through it instead of driving a browser step by step. Today the agent can run, list, inspect, extract and delete repros through the MCP server, but it cannot record one. Every recording signs in again, a dead token surfaces as an unrelated step failure, the shared steps live inside a directory that is gitignored as a whole, extraction waits to be asked, and the agent learns what the project has only by calling tools. Five gaps, one design.

What already exists and is kept: per repro `state.json` for hand recordings, `establishesSession`, `repro extract`, `repro_steps`, warm sessions in the MCP server, the no model calls rule, refuse rather than guess, and the hand editable IR.

## 1. Layout, config and `repro init`

### Layout

Everything the tool owns stays under `.repros/`. Two kinds of content live there.

```
.repros/
  config.json            committed   project settings
  steps/*.mjs            committed   shared setup steps, unchanged location
  drive/<name>.mjs       ignored     agent written recording scripts
  sessions/<key>.json    ignored     project auth sessions
  <name>.json            ignored     repro IR, as today
  <name>/                ignored     state, artifacts, last result, as today
```

Drive files are disposable with their repro. `repro rm <name>` and `repro_delete` also remove `.repros/drive/<name>.mjs` when it exists.

### Config

`.repros/config.json`, validated with zod. A missing file means defaults. An invalid file fails naming the file and the field.

```json
{ "extractThreshold": 4 }
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `extractThreshold` | integer, minimum 2 | 4 | Repros sharing a prefix before the tool nudges toward extraction |

`repro extract --min-repros` and the MCP `min_repros` override it per call. No other field is added until something needs it.

Module: `src/config.ts` exporting `loadConfig(root): Promise<Config>` and `CONFIG_PATH`.

### `repro init`

Idempotent. Prints every change. Writes nothing outside these three actions.

1. Appends to the host `.gitignore`, creating it if absent. Skipped when the line `.repros/*` is already present.
   ```
   # fast-replay: repros and sessions are disposable and hold tokens; steps and config are shared
   .repros/*
   !.repros/steps/
   !.repros/config.json
   ```
2. Writes `.repros/config.json` with defaults if absent, and creates `.repros/steps/`.
3. Prints two snippets without writing them: the MCP server config line for the agent's client, and the CLAUDE.md workflow block. The block is the same string the MCP server sends as `instructions` (section 4), exported from one module so the two cannot drift.

Session files are never committed. Credentials for a sign-in step come from env inside the step's own code, never from the IR or a session file.

## 2. Project sessions

### The idea

A session belongs to the project and the account, not to the repro. A step marked `establishesSession` produces one, and every repro that walks through that step shares it. Ten issues means one sign-in, plus one more each time the token dies.

### Where it lives

`.repros/sessions/<step>[.<params-hash>]@<host>.json`

- `step`: the session step's name.
- `params-hash`: first six hex characters of a sha256 over the explicit params the caller passed, sorted by key. Omitted when no explicit params were passed. Defaults from the step definition are not part of the key, so changing a default does not orphan the file.
- `host`: `URL.host` of the origin the session was minted against, port included, with `:` written as `_` so the file name is legal on every platform (`localhost_3000`).

```
.repros/sessions/signed-in@localhost_3000.json
.repros/sessions/signed-in@localhost_3000.meta.json
.repros/sessions/signed-in@staging.example.com.json
.repros/sessions/new-account.a91f3c@staging.example.com.json
```

The `.json` file is a raw Playwright storage state, so it still works with `--storage-state` by hand. The `.meta.json` sidecar records what the tool has learned about it:

```json
{ "mintedAt": "2026-09-02T09:14:00Z", "provenPaths": ["/", "/workspaces"] }
```

`provenPaths` lists the start paths on which the step's `ensures` selector was seen visible right after a real sign-in. It is the only evidence that probing this session on that path is meaningful, and nothing below probes without it.

Module: `src/sessions.ts` exporting `sessionKey(step, params)`, `sessionFiles(root, key, host)`, `readSession`, `writeSession`, `readMeta`, `writeMeta`, and the shared `establishSession` routine below.

### Record time

A recording declares its session step up front, because Playwright seeds a session only when a context is created. `RecordOptions` gains `setup?: { step: string; params?: Record<string, string> }[]`; the drive file (section 3) declares the same. The recorder resolves the `requires` closure of the declared steps and finds the session steps.

Exactly one session step in the closure. The decision is made from the session file, its sidecar and the recording's start path, before the browser opens:

1. **Proven path, session present.** The session file has content and `provenPaths` contains the start path. Open the context seeded from it, load the start path, wait for the step's `ensures` selector with the step's `ensuresTimeoutMs` (default 30 s). Visible means fresh: the step is marked as run, no sign-in happens. Not visible means expired: run the step for real through `runStep`, capture the session with IndexedDB, rewrite the file and refresh `mintedAt`.
2. **Unproven path, or no session.** Open a fresh context and run the step for real. No probe is attempted, because a probe on a path where `ensures` has never been seen would wait the full timeout and then sign in anyway. Capture and write the session file.
3. **Proof.** After any real sign-in, navigate to the start path and check `ensures` once. Visible: the start path is added to `provenPaths`, and the repro is marked probeable. Not visible: a warning names the step, the selector and the path, and says this repro will restore the session without checking it. Nothing else changes.
4. Declared non-session steps in `setup` run next, through `runStep`, with the same `ran` set, before `drive` is called.
5. The repro's `storageStatePath` points at the shared session file, project relative. No per repro `state.json` is written for such a repro.

The probeable marker is a new optional top-level IR field, hand editable and backward readable, so `IR_VERSION` stays at 1:

```json
"sessionCheck": { "step": "signed-in" }
```

It means: before trusting the restored session, verify this step's `ensures` on the start path. It is written only when record time proved the check works for this repro, and a user can add it by hand once a step's `ensures` names something global. Its absence is the instruction to behave as today.

No session step in the closure: behaviour is unchanged. The pre drive snapshot goes to the per repro `state.json`.

An explicit `--storage-state` or `--profile` on the recording wins over a declared session: reuse is disabled for that recording, the session step runs as today, and the recorder prints a note saying which option disabled reuse. Two ways of seeding one context cannot both apply.

Two or more session steps in the closure: reuse is disabled for the recording, every step runs, the per repro `state.json` receives the final snapshot, no `sessionCheck` is written, and the recorder prints a note saying a single seeded state cannot represent two accounts.

`api.step()` inside `drive` keeps working. Calling a session step there rather than declaring it runs the step for real, captures, writes the shared file for its key and host, records proof for the start path if `ensures` is visible there at that moment, and points the repro at the shared file. This recording paid the sign-in; the next one that declares the step does not.

The recorded IR lists every setup step in `setup[]`, declared or invoked, in execution order, with the explicit params passed. This is what replay uses to recompute the key.

### Replay time

`runRepro` seeds the context from the repro's `storageStatePath` as today and marks session steps as run when a session was restored, exactly as now. The new behaviour applies only to a repro carrying `sessionCheck`, after the start page loads:

1. Wait for the named step's `ensures` selector with the step's timeout. Visible: the session is alive, the step stays skipped, zero sign-ins.
2. Not visible: the session has expired. Run the step once through `runStep`, capture the session, write it to the session file for the key and the host replay is running against, refresh `mintedAt`, navigate back to the start path, and push the note `session re-established via step "<name>" (stored session had expired)` onto `result.notes`. Replay continues.
3. If the step throws during re-establishment, the run fails as `kind: 'infrastructure'`, `COULD NOT VERIFY`, naming the step and its file, as setup failures do today.

A repro without `sessionCheck` takes today's path by construction: restore, skip, no probe, no heal. That covers every repro recorded before this change and every repro whose record time could not prove the check.

Both record and replay call one routine, `establishSession`, so the probe and the heal cannot diverge.

Under `--profile`, the profile holds the session. The probe and heal still run for a repro with `sessionCheck`, so an expired login in the profile is re-established and noted, but nothing is written to `.repros/sessions/`.

Under `--env`, `resolveSessionSeed` first looks for the target host's own session file for the same key. Present with content, it is seeded directly with no retargeting. Missing, it falls back to retargeting the recorded host's file in memory as today. A heal under `--env` writes the recaptured session and its sidecar to the target host's files and never touches the recorded host's files, so the second `--env` replay starts warm.

Warm sessions in the MCP server are seeded through `openSession`, which uses `resolveSessionSeed`, so they receive the same probe and heal inside the warm context.

### Contract on `ensures`

For a session step, `ensures` doubles as the freshness check, so it should name something visible on every signed-in page: an account menu or avatar rather than a home screen element. A page specific selector is not an error. It only means fewer start paths get proven, so fewer repros carry `sessionCheck` and more recordings pay a real sign-in. The rule is stated in the README and in the `StepDefinition` comment, and the record time warning in step 3 above says exactly which path failed to prove.

A session step with no `ensures` cannot be probed or proven. It behaves exactly as today: runs at record, skipped on replay when a session was restored, no reuse across repros. `repro steps`, `repro_steps` and the record output say why it is not reused.

### Safety rules

- A session file with no cookies and no origins is not a session. The existing `storageStateHasContent` guard applies to project session files.
- Nothing probes without proof. Record time probes only on a path in `provenPaths`; replay probes only a repro carrying `sessionCheck`. A probe that cannot be trusted would sign in on every run, which is the failure this design exists to remove.
- A heal is never silent. The note is always present in the result, and the MCP `repro_run` output prints notes already.
- A heal happens at most once per run. If `ensures` is still not visible after re-establishment, the run is `COULD NOT VERIFY` naming the step.

### Compatibility

No IR version bump. `sessionCheck` is optional. Old repros lack it, have a per repro `state.json`, and take the unchanged path by construction. `repro rm` does not delete session files, which live outside the repro's sidecar directory.

## 3. Agent recording

### The drive file

```js
// .repros/drive/checkout-crash.mjs
import { defineDrive } from 'fast-replay';

export default defineDrive({
  setup: [{ step: 'signed-in' }],
  async drive(page, { step, observe }) {
    await page.click('[data-testid="checkout"]');
    await observe('text=Something went wrong');
  },
});
```

`defineDrive` is an identity function for typing, like `defineStep`, exported from `src/api.ts` and defined in `src/drive.ts` beside `loadDrive(file)`. `setup` is the declared preamble from section 2. `drive` receives the same `page` and `DriveApi` the programmatic path already does.

`loadDrive` imports the module by file URL and refuses, naming the file, when the default export lacks a `drive` function, using the same wording `loadSteps` uses for a bad step file.

Node caches an ES module by URL for the life of the process. The MCP server is long lived, and the expected loop is a partial recording, an edit to the drive file, and a second `repro_record`, which would otherwise run the first version. `loadDrive` appends the file's mtime as a query string to the import URL, so an edited file is a new module. `loadSteps` gets the same treatment, since "fix the step once" also runs through the live server and today a step edited while the server runs is not picked up until restart.

### CLI

`repro record <name> --url <base> --drive <file> [--headed]`. With `--drive` the recording is headless by default, since a driven recording has nobody watching; `--headed` overrides for apps that refuse headless. Without `--drive` the command behaves exactly as today, including remaining headed. A `PartialRecordingError` prints the surviving step count, the IR path and the driver's error, exit code 1.

### MCP: `repro_record`

Input:

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Repro name, validated by `assertValidName` |
| `url` | yes | Base URL |
| `drive` | yes | Path to the drive file, relative to the project root or absolute |
| `start_path` | no | Default `/` |
| `headed` | no | Default false |
| `viewport` | no | `WxH`, default `1440x900` |

Runs in the pooled browser like `repro_run`, so the record path accepts a `browser` the same way `run` does. Output, in one call:

- Steps captured, IR path, stop reason.
- The bug signature observed at record time: console errors and failed requests from `observedAtRecord`, and the `observe` evidence declared.
- Session status: `reused`, `established`, `re-established`, or `none`.
- When nothing was observed and no `observe` was declared: a line stating that `expect_fixed` will refuse until `repro assert --fixed` names a criterion.
- On a partial recording: the surviving step count, the driver's error, the IR path, `isError: true`.
- The extraction nudge (section 4) when this recording brought a prefix to the threshold.

`structuredContent` mirrors the above with `name`, `irPath`, `steps`, `stopReason`, `observed`, `session`, `partial`, `error`.

### What does not change

The IR a drive file produces is the same IR a human recording produces. Steps keep `author: 'human'`, since the field describes who performed the actions and no model did. `repro auto` from a bug description stays unbuilt.

## 4. Knowing the project first, and the extraction nudge

### MCP instructions

The SDK sends `instructions` to the client during initialize. The server fills it with two parts.

1. The static workflow, exported from `src/agent-notes.ts` and shared with `repro init`:
   check `repro_steps` before writing setup; write a drive file and call `repro_record`; verify with `repro_run` and `expect_fixed` after each change; `repro_extract` when nudged; `repro_delete` once the fix is confirmed.
2. A snapshot of the project at connect time: each shared step with description, requires, session flag, and for session steps whether a stored session exists per host and its age; each repro with step count and last result; the distinct base URLs the repros were recorded against; extraction candidates at or above the threshold.

Bounded: names and one line descriptions only, never IR bodies. Target is a few hundred tokens for a typical project.

Loading steps imports modules, so `createReplayServer` and `createServer` become async. `src/mcp/index.ts` awaits it. Tests await it.

### The nudge

Extraction stays suggest only and caller named. The change is that the tool says when the threshold is crossed instead of waiting to be asked.

Where: after `repro record` and `repro_record`; in `repro list` and `repro_list`. Not in `repro_run`, which stays about the bug.

Text, one line per candidate at or above `extractThreshold`:

```
4 repros share a 3-step prefix starting at /workspaces — repro extract to make it a shared step
```

Source: `suggestExtractions({ minRepros: config.extractThreshold })`, exact matches only. Nothing is written. The line disappears once the prefix is extracted or the repros are deleted.

## 5. Testing, docs and rollout

### Fixture

The demo app has no login. `examples/demo-app/src/App.tsx` gains one element, test id `signed-in-badge`, rendered only when `localStorage.getItem('replay-token') === 'ok'`. A session file whose token is `stale` simulates expiry. The existing `session` step in `tests/steps.test.ts` changes its `ensures` to `[data-testid="signed-in-badge"]`.
The badge is rendered on every route of the demo app, so the session step's `ensures` is global and every start path proves.

### Tests

Config and init (`tests/config.test.ts`, `tests/cli-init.test.ts`):
- defaults when the file is missing; a bad threshold fails naming the field;
- `.gitignore` append is idempotent and preserves existing content; snippets print.

Sessions (`tests/sessions.test.ts`, extending the fixtures in `tests/steps.test.ts`):
- two recordings declaring the same session step sign in once in total; the shared file exists; neither repro has a per repro `state.json`;
- three replays sign in zero times;
- a stale session file heals exactly once, rewrites the shared file, adds the note; the following replay signs in zero times;
- a step that throws during heal reports `COULD NOT VERIFY` naming the step;
- a heal under `--env` writes the target host's file and leaves the recorded host's file unchanged;
- a session step without `ensures` is not reused and the record output says why;
- two session steps in one closure disable reuse with a note;
- `api.step()` on a session step writes the shared file and points the repro at it.
- a step whose `ensures` is not visible on the start path produces a warning, no `sessionCheck`, and a repro that restores without probing and never heals;
- `sessionCheck` added by hand to such a repro turns the probe on;
- a recording on an unproven path signs in for real without waiting on a probe, and proves the path for the next recording;
- a repro recorded by the previous release, with a per repro `state.json` and no `sessionCheck`, replays unchanged.

Recording (`tests/drive.test.ts`, `tests/mcp.test.ts`):
- `repro record --drive` and `repro_record` produce the same IR as a programmatic `record` of the same flow, timing fields aside;
- a partial recording reports surviving steps and the error;
- a file without `defineDrive` is refused by name;
- editing a drive file between two `repro_record` calls in one server process runs the edited version; the same for a step file between two `repro_run` calls;
- the result carries observed evidence and the session status.

Awareness (`tests/mcp.test.ts`, `tests/extract.test.ts`):
- `instructions` names each step, each repro and the workflow;
- the nudge appears in `repro_list` once the threshold is met and disappears after `repro_extract`;
- the `repro_run` output never carries the nudge.

The existing suites stay green unchanged. That is the proof old repros behave as before.

### Docs

- README: `repro init` in the Use section; an "Agents record too" block under the coding agent section with the drive file; the sessions paragraph replaces the current `establishesSession` paragraph; the `ensures` contract for session steps.
- CLAUDE.md: project sessions, drive files, config, `repro init`.
- CHANGELOG 0.13.0 in the house style: what was wrong, what changed, the trade.

### Rollout

One release, 0.13.0. Implementation order follows the dependencies: config and init; sessions; recording; instructions and nudge; docs. Each lands with its tests through the normal review flow.

### Not in scope

Choosing a step from an issue's prose. Self healing selectors. Restoring a session into an already open context. `repro auto`. Committing session files in any form.
