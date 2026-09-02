import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { isDurableSelector } from './compiler/compile.js';
import { loadConfig } from './config.js';
import {
  applyExtraction,
  findCommonPrefixes,
  type PrefixCandidate,
} from './ir/extract.js';
import { assertValidName, listRepros, readRepro, reproPaths, writeFileAtomic, writeRepro } from './ir/io.js';
import { StepSchema, type Repro, type Step } from './ir/schema.js';
import { loadSteps, STEPS_DIR } from './steps.js';

/**
 * The suggest/apply surface over `ir/extract.ts` that the CLI and MCP share.
 *
 * Suggest never writes. Apply writes exactly two kinds of thing — one new step
 * module, and the repros whose prefix it verified — and reports every change
 * it made, in the `repro fix` tradition.
 */

export interface ExtractSuggestion {
  /** Position in the suggestion list; `applyExtract` selects by this. */
  index: number;
  stepCount: number;
  startPath: string;
  /** Repros whose prefix matches exactly and would be rewritten on apply. */
  repros: string[];
  /** Repros that match only after masking — same shape, different values. */
  inexactRepros: string[];
  /** One line per step, for a human choosing between candidates. */
  preview: string[];
  /** The full candidate, for programmatic callers. */
  candidate: PrefixCandidate;
}

export interface ExistingStepMatch {
  step: string;
  /** Repros whose recorded prefix re-drives this step's fragment by hand. */
  repros: { name: string; length: number }[];
}

export interface SuggestExtractOptions {
  root?: string;
  minSteps?: number;
  minRepros?: number;
  stepsDir?: string;
}

async function readAll(root: string): Promise<{ name: string; repro: Repro }[]> {
  const repros: { name: string; repro: Repro }[] = [];
  for (const summary of await listRepros(root)) {
    if (summary.error) continue;
    repros.push({ name: summary.name, repro: await readRepro(summary.name, root) });
  }
  return repros;
}

function parseFragment(fragment: unknown): Step[] | null {
  const parsed = z.array(StepSchema).safeParse(fragment);
  return parsed.success && parsed.data.length ? parsed.data : null;
}

export async function suggestExtractions(options: SuggestExtractOptions = {}): Promise<{
  suggestions: ExtractSuggestion[];
  existing: ExistingStepMatch[];
}> {
  const root = options.root ?? process.cwd();
  const repros = await readAll(root);
  const suggestions = findCommonPrefixes(repros, options).map((candidate, index) => ({
    index,
    stepCount: candidate.steps.length,
    startPath: candidate.startPath,
    repros: candidate.repros.filter((r) => r.exact).map((r) => r.name),
    inexactRepros: candidate.repros.filter((r) => !r.exact).map((r) => r.name),
    preview: candidate.steps.map(
      (s) => `${s.id}  ${s.action.padEnd(8)} ${s.target?.semantic ?? s.value ?? ''}`,
    ),
    candidate,
  }));

  // A recording that re-drove an already-extracted preamble by hand: the fix
  // is one convert, not a new step.
  const { steps } = await loadSteps(options.stepsDir ?? path.join(root, STEPS_DIR));
  const existing: ExistingStepMatch[] = [];
  for (const step of steps.values()) {
    const fragment = step.fragment ? parseFragment(step.fragment) : null;
    if (!fragment) continue;
    const matches = repros
      .filter(({ repro }) => applyExtraction(repro, fragment, step.name).applied)
      .map(({ name }) => ({ name, length: fragment.length }));
    if (matches.length) existing.push({ step: step.name, repros: matches });
  }

  return { suggestions, existing };
}

export interface ApplyExtractOptions {
  /** Name for the new shared step. The caller names it — never inferred. */
  name?: string;
  root?: string;
  /** Which suggestion to extract (default 0, the widest). */
  candidate?: number;
  /** Take only the first N steps of the candidate's prefix. */
  length?: number;
  /** What state the step leaves you in. Defaults to naming its provenance. */
  description?: string;
  /** The caller's judgement that this preamble's whole effect is the session. */
  establishesSession?: boolean;
  /** Convert matching repros onto this existing step instead of writing a new one. */
  useExisting?: string;
  /** Module specifier the generated step imports from. Tests point it at a shim. */
  importFrom?: string;
  minSteps?: number;
  minRepros?: number;
  stepsDir?: string;
}

export interface ExtractReport {
  /** Path of the step module written; null when converting onto an existing step. */
  stepFile: string | null;
  stepName: string;
  perRepro: { name: string; changes: string[]; skipped?: string }[];
}

export async function applyExtract(options: ApplyExtractOptions): Promise<ExtractReport> {
  const root = options.root ?? process.cwd();
  const stepsDir = options.stepsDir ?? path.join(root, STEPS_DIR);

  if (options.useExisting) {
    const { steps } = await loadSteps(stepsDir);
    const step = steps.get(options.useExisting);
    if (!step) {
      throw new Error(`No shared step named "${options.useExisting}" in ${stepsDir}.`);
    }
    const fragment = step.fragment ? parseFragment(step.fragment) : null;
    if (!fragment) {
      throw new Error(
        `Shared step "${step.name}" carries no replayable fragment — only steps generated by ` +
          `repro extract can be matched against recordings.`,
      );
    }
    const perRepro: ExtractReport['perRepro'] = [];
    for (const { name, repro } of await readAll(root)) {
      const result = applyExtraction(repro, fragment, step.name);
      if (result.applied) {
        await writeRepro(result.repro, reproPaths(name, root));
        perRepro.push({ name, changes: result.changes });
      } else if (result.reason?.includes('masking')) {
        // Same shape, different values — worth telling; a plain non-match is
        // just a repro this step has nothing to do with.
        perRepro.push({ name, changes: [], skipped: result.reason });
      }
    }
    return { stepFile: null, stepName: step.name, perRepro };
  }

  const name = options.name;
  if (!name) throw new Error('applyExtract needs a step name (or useExisting).');
  assertValidName(name);

  const { suggestions } = await suggestExtractions({ ...options, root, stepsDir });
  const suggestion = suggestions[options.candidate ?? 0];
  if (!suggestion) {
    throw new Error(
      suggestions.length
        ? `No extraction candidate #${options.candidate}. There are ${suggestions.length}.`
        : 'No repeated prefix found across the recorded repros.',
    );
  }
  const length = options.length ?? suggestion.stepCount;
  if (length < 1 || length > suggestion.stepCount) {
    throw new Error(`--length must be between 1 and ${suggestion.stepCount} for this candidate.`);
  }
  const fragment = suggestion.candidate.steps.slice(0, length);

  const file = path.join(stepsDir, `${name}.mjs`);
  if (existsSync(file)) {
    throw new Error(`${file} already exists — refusing to overwrite a shared step.`);
  }
  const { steps: loaded } = await loadSteps(stepsDir);
  const clash = loaded.get(name);
  if (clash) {
    throw new Error(`A shared step named "${name}" already exists (${clash.file}).`);
  }

  // A criterion is derived only when the fragment's own last wait names a
  // durable selector; anything shakier is left for the author to add.
  const last = fragment[fragment.length - 1]!;
  const ensures = (last.waitAfter.domAppeared ?? []).find(isDurableSelector);

  await writeFileAtomic(
    file,
    renderStepModule(
      {
        name,
        description:
          options.description ??
          `Extracted from ${suggestion.repros.length} repro(s): ${suggestion.repros.join(', ')}`,
        ...(ensures ? { ensures } : {}),
        ...(options.establishesSession ? { establishesSession: true } : {}),
        sourceRepros: suggestion.repros,
        importFrom: options.importFrom,
      },
      fragment,
    ),
  );

  const perRepro: ExtractReport['perRepro'] = [];
  for (const memberName of [...suggestion.repros, ...suggestion.inexactRepros]) {
    // Re-read at apply time: the suggestion may be stale, and applyExtraction
    // re-verifies against what is on disk now.
    const repro = await readRepro(memberName, root);
    const result = applyExtraction(repro, fragment, name, {
      fragmentBaseUrl: suggestion.candidate.baseUrl,
    });
    if (result.applied) {
      await writeRepro(result.repro, reproPaths(memberName, root));
      perRepro.push({ name: memberName, changes: result.changes });
    } else {
      perRepro.push({ name: memberName, changes: [], skipped: result.reason ?? 'did not match' });
    }
  }

  return { stepFile: file, stepName: name, perRepro };
}

export interface RenderStepOptions {
  name: string;
  description: string;
  ensures?: string;
  establishesSession?: boolean;
  /** Named in the generated header so a reader knows where the steps came from. */
  sourceRepros: string[];
  /** Module specifier to import from; defaults to the published package name. */
  importFrom?: string;
}

/** The generated `.mjs` — plain `defineStep` file, fragment visible as JSON. */
export function renderStepModule(def: RenderStepOptions, fragment: Step[]): string {
  const importFrom = def.importFrom ?? 'fast-replay';
  const fields = [
    `  name: ${JSON.stringify(def.name)},`,
    `  description: ${JSON.stringify(def.description)},`,
    ...(def.ensures ? [`  ensures: ${JSON.stringify(def.ensures)},`] : []),
    ...(def.establishesSession ? [`  establishesSession: true,`] : []),
  ].join('\n');

  return (
    `import { defineStep, replayFragment } from ${JSON.stringify(importFrom)};\n\n` +
    `// Extracted by \`repro extract\` from the common prefix of: ${def.sourceRepros.join(', ')}.\n` +
    `// The steps below are ordinary repro IR — edit selectors and waits here, or\n` +
    `// replace run() with hand-written Playwright code when you outgrow the\n` +
    `// recording. Keep \`fragment\` if you do: it is how repro extract recognizes\n` +
    `// a recording that re-drives this preamble by hand.\n` +
    `const steps = ${JSON.stringify(fragment, null, 2)};\n\n` +
    `export default defineStep({\n` +
    `${fields}\n` +
    `  fragment: steps,\n` +
    `  async run(page) {\n` +
    `    await replayFragment(page, steps);\n` +
    `  },\n` +
    `});\n`
  );
}

/**
 * One line per prefix shared by at least `extractThreshold` repros.
 *
 * The threshold is the project's, so a team decides once how much repetition
 * is worth a shared step. Only exact matches count: a near match still needs
 * a hand to parameterize it, and nudging toward a rewrite that will be
 * refused helps nobody. Nothing here writes.
 */
export async function extractionNudge(root = process.cwd()): Promise<string[]> {
  let extractThreshold: number;
  let suggestions: ExtractSuggestion[];
  try {
    ({ extractThreshold } = await loadConfig(root));
    ({ suggestions } = await suggestExtractions({ root, minRepros: extractThreshold }));
  } catch (err) {
    // A nudge is auxiliary output. A broken config must not turn a finished
    // recording or listing into a failure, and must not vanish either.
    // loadConfig puts the offending field on its own line (e.g. "Invalid
    // .repros/config.json\n  extractThreshold: ..."); collapsing newlines
    // keeps the nudge one line without dropping which field is wrong.
    return [`Could not check for repeated prefixes: ${(err as Error).message.replace(/\n/g, '; ')}`];
  }
  return suggestions
    .filter((s) => s.repros.length >= extractThreshold)
    .map(
      (s) =>
        `${s.repros.length} repros share a ${s.stepCount}-step prefix starting at ${s.startPath} — ` +
        'repro extract to make it a shared step',
    );
}
