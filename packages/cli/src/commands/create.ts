/**
 * `personaxis create`, Genesis: a governed AI Persona from zero, every entry
 * case covered (docs/architecture/genesis.md):
 *
 *   personaxis create                          # psychometric interview (TTY)
 *   personaxis create --from-prompt "<brief>"  # natural language
 *   personaxis create --from-project [dir]     # infer from the project's docs
 *   personaxis create --from-import <file>     # SOUL.md / SoulSpec dir, character card V2/V3 (.json/.png),
 *                                              # system prompt, CLAUDE.md/AGENTS.md
 *   personaxis create --from-transcript <file> # exemplar conversations
 *
 * Modes COMPOSE (later evidence wins per field; the report shows overrides).
 * Output is never a prose blob: personaxis.md (validated PASS, Genesis never
 * writes an invalid persona), state.json, compiled PERSONA.md (stage-1
 * assembler), and creation-report.md with per-number provenance.
 */

import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, relative, basename } from "node:path";
import chalk from "chalk";
import {
  genesis,
  mergeSeed,
  buildSpecDocument,
  pendingItems,
  applyAnswers,
  loadDraft,
  saveDraft,
  clearDraft,
  ITEM_BANK,
  ITEM_BANK_VERSION,
  importCharacterCard,
  importPrompt,
  importSoulMd,
  isSoulImport,
  extractSeed,
  heuristicSeed,
  renderCreationReport,
  provenanceSummary,
  loadPersona,
  ensureState,
  assemblePersonaDoc,
  extractEnvelopes,
  staticallyDecorative,
  canCross,
  type PersonaFrontmatter,
  type SeedContribution,
  type StructuredCaller,
  type InterviewAnswers,
  type GenesisResult,
} from "@personaxis/core";
import { resolveModel } from "@personaxis/core";
import { runCompile } from "./compile.js";
import { validatePersona, exitCodeFor } from "../schema.js";
import { runRules } from "../linter/rules.js";
import { buildResourceManifest } from "../resource-manifest.js";
import { resolveProvider, type ProviderName } from "../providers/index.js";

interface CreateOpts {
  fromPrompt?: string;
  fromProject?: string | boolean;
  fromImport?: string;
  fromTranscript?: string;
  root?: boolean;
  yes?: boolean;
  json?: boolean;
  provider?: ProviderName;
  /** V5.P2.5: commander maps --no-polish onto polish:false. */
  polish?: boolean;
  noPolish?: boolean;
  /** Ask the whole question bank instead of the twelve core ones. */
  deep?: boolean;
}

/** Provider adapter → core's StructuredCaller. Null when no model is usable. */
function structuredCaller(name?: ProviderName): StructuredCaller | null {
  try {
    const provider = resolveProvider(name);
    if (provider.name === "agent") return null; // no network on our side; heuristic path
    if (provider.runStructured) {
      return (prompt, schema, schemaName) => provider.runStructured!(prompt, schema, schemaName).then((r) => r.json);
    }
    return async (prompt) => {
      const r = await provider.run(prompt + "\n\nReturn ONLY a JSON object, no prose, no fences.");
      return JSON.parse(r.text.trim().replace(/^```[a-zA-Z]*\s*\n?|\n?```$/g, "")) as unknown;
    };
  } catch {
    return null;
  }
}

/**
 * The interview, in one of two depths, resumable.
 *
 *   core  twelve questions: who it is, the five trait axes, what it values, how it sounds,
 *         and what it must never do. Everything else falls back to a LABELED default whose
 *         provenance says "not stated", so the creation report separates what the author
 *         decided from what the tool assumed.
 *   deep  the whole bank, adding envelope width, mood half-life, refusal detail,
 *         uncertainty thresholds, memory policy, improvement posture and a voice exemplar.
 *
 * Answers are written to a draft as they are given, so abandoning the deep interview at
 * question 17 does not cost the sixteen already answered. The draft is deleted once the
 * persona exists.
 */
async function runInterview(depth: "core" | "deep", dir: string): Promise<SeedContribution> {
  const resumed = loadDraft(dir, ITEM_BANK_VERSION);
  let answers: InterviewAnswers = {};
  if (resumed && resumed.depth === depth) {
    const n = Object.keys(resumed.answers).length;
    const total = ITEM_BANK.filter((i) => depth === "deep" || i.depth === "core").length;
    console.log(
      chalk.yellow(`\n  An unfinished interview was found: ${n} of ${total} answered `) +
        chalk.dim(`(${resumed.updated.slice(0, 16).replace("T", " ")}).`),
    );
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let keep = "y";
    try {
      keep = ((await rl.question(`  Continue where you left off? ${chalk.dim("[Y/n]")} `)) || "y").trim().toLowerCase();
    } finally {
      rl.close();
    }
    if (keep === "y" || keep === "yes") answers = resumed.answers;
    else clearDraft(dir);
  }

  const remaining = pendingItems(answers, depth);
  const save = (a: InterviewAnswers): void =>
    saveDraft(dir, { answers: { ...answers, ...a }, depth, bankVersion: ITEM_BANK_VERSION });

  // F6.7b: the Ink wizard is the primary interview surface, progress, live
  // field→rule mapping per answer, arrow-key inputs. Lazy import (Ink costs ~1 s;
  // only the interview path pays it); readline below stays as the fallback for
  // odd terminals (PERSONAXIS_NO_WIZARD=1 forces it).
  if (process.stdin.isTTY && process.stdout.isTTY && process.env.PERSONAXIS_NO_WIZARD !== "1") {
    try {
      const { runInterviewWizard } = await import("@personaxis/tui");
      const wizardAnswers = await runInterviewWizard(remaining, save);
      const { seed, evidence } = applyAnswers({ ...answers, ...wizardAnswers });
      return { label: "interview", seed, evidence };
    } catch {
      /* fall through to readline */
    }
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(
    chalk.bold("\nGenesis interview") +
      chalk.dim(` (${depth === "core" ? "core: the twelve that decide who it is" : "deep: the full bank"}), every answer becomes auditable evidence; Enter skips a question.\n`),
  );
  try {
    for (const item of remaining) {
      if (item.kind === "likert") {
        const raw = (await rl.question(`${chalk.cyan(item.question)}\n  ${chalk.dim("1 strongly disagree … 5 strongly agree")} > `)).trim();
        if (raw) answers[item.id] = Number(raw);
      } else if (item.kind === "choice") {
        console.log(chalk.cyan(item.question));
        item.options!.forEach((o, i) => console.log(`  ${chalk.dim(String(i + 1) + ".")} ${o}`));
        const raw = (await rl.question("  > ")).trim();
        if (raw) answers[item.id] = Number(raw) - 1;
      } else if (item.kind === "rank") {
        console.log(chalk.cyan(item.question));
        console.log("  " + item.candidates!.map((c, i) => `${chalk.dim(String(i + 1) + ".")}${c}`).join("  "));
        const raw = (await rl.question(`  ${chalk.dim("order as numbers, e.g. 3 1 2 …")} > `)).trim();
        if (raw) {
          const order = raw.split(/[\s,]+/).map((n) => item.candidates![Number(n) - 1]).filter(Boolean);
          if (order.length) answers[item.id] = order;
        }
      } else {
        const raw = (await rl.question(`${chalk.cyan(item.question)} > `)).trim();
        if (raw) answers[item.id] = raw;
      }
      save(answers);
    }
  } finally {
    rl.close();
  }
  const { seed, evidence } = applyAnswers(answers);
  return { label: "interview", seed, evidence };
}

/**
 * Gather the project's own words, BOUNDED by design (V5.P2.5): only the
 * default-read/agent files, 6,000 chars per file, 24,000 chars total. Never the
 * whole project: a giant repo costs the same as a small one.
 */
const PROJECT_FILES = ["README.md", "CLAUDE.md", "AGENTS.md", "SOUL.md", "package.json", "docs/HOW_IT_WORKS.md"] as const;
const PROJECT_TOTAL_BUDGET = 24_000;

function projectMaterial(dir: string): { material: string; files: string[]; chars: number } {
  const parts: string[] = [`RESOURCE MANIFEST:\n${buildResourceManifest(dir) ?? "(none)"}`];
  const files: string[] = [];
  let total = parts[0].length;
  for (const f of PROJECT_FILES) {
    const p = join(dir, f);
    if (!existsSync(p)) continue;
    const room = PROJECT_TOTAL_BUDGET - total;
    if (room <= 0) break;
    const chunk = readFileSync(p, "utf-8").slice(0, Math.min(6000, room));
    parts.push(`FILE ${f}:\n${chunk}`);
    files.push(f);
    total += chunk.length;
  }
  return { material: parts.join("\n\n"), files, chars: total };
}

/**
 * How the persona is going to be built, asked as a QUESTION rather than hidden behind
 * flags. Running `create` with no arguments dropped straight into the interview, so the
 * other four sources existed only for whoever had read `--help`.
 *
 * It fills the SAME options the flags fill, so there is exactly one code path per source:
 * a picker that re-implemented each source would be a second place for them to drift.
 * Passing any `--from-*` flag skips this screen entirely, which is what scripts and agents
 * do. Returns false when the user cancels.
 */
async function chooseSource(opts: CreateOpts): Promise<boolean> {
  const { selectCards, promptText } = await import("@personaxis/tui/prompt");
  const choice = await selectCards(
    "How should this persona be created?",
    [
      { value: "core", title: "Answer 12 questions", desc: "who it is, its five trait axes, what it values, how it sounds, what it must never do" },
      { value: "deep", title: "Answer the full bank (20)", desc: "adds envelope width, mood half-life, refusals, uncertainty, memory, improvement, a voice exemplar" },
      { value: "prompt", title: "Describe it in a sentence", desc: "a natural-language brief; a model turns it into governed coordinates" },
      { value: "project", title: "Infer it from this project", desc: "reads only README / CLAUDE.md / AGENTS.md / SOUL.md, within a fixed budget" },
      { value: "import", title: "Import an existing one", desc: "SOUL.md, a character card (V2/V3), a system prompt, CLAUDE.md or AGENTS.md" },
      { value: "transcript", title: "Induce it from transcripts", desc: "the persona that best explains example conversations" },
    ],
    "up/down choose - Enter confirm - Esc cancel - every path ends in a validated, governed spec",
  );
  if (!choice) return false;
  if (choice === "core" || choice === "deep") {
    opts.deep = choice === "deep";
    return true;
  }
  if (choice === "project") {
    opts.fromProject = process.cwd();
    return true;
  }
  const label =
    choice === "prompt"
      ? "Describe the persona in a sentence"
      : choice === "import"
        ? "Path to the file or directory to import"
        : "Path to the transcript file";
  const value = (await promptText(label)).trim();
  if (!value) return false;
  if (choice === "prompt") opts.fromPrompt = value;
  else if (choice === "import") opts.fromImport = value;
  else opts.fromTranscript = value;
  return true;
}

export async function runCreate(slugArg: string | undefined, opts: CreateOpts): Promise<void> {
  // No source flag and a terminal to ask in: show the sources instead of assuming one.
  const noSource = !opts.fromPrompt && opts.fromProject === undefined && !opts.fromImport && !opts.fromTranscript;
  if (noSource && process.stdin.isTTY && process.stdout.isTTY && !opts.yes && !opts.json && !opts.deep) {
    if (!(await chooseSource(opts))) {
      console.log(chalk.dim("  Cancelled; nothing was written."));
      return;
    }
  }

  const contributions: SeedContribution[] = [];
  const call = structuredCaller(opts.provider);
  const llmNotes: string[] = [];

  const extractOr = async (material: string, label: string, fallbackBrief?: string): Promise<SeedContribution> => {
    if (call) {
      try {
        const { seed, evidence } = await extractSeed(material, label, call);
        return { label, seed, evidence };
      } catch (e) {
        llmNotes.push(`extractor failed for ${label} (${(e as Error).message}); heuristic baseline used`);
      }
    } else {
      llmNotes.push(`no model provider available for ${label}; heuristic baseline used (labeled defaults)`);
    }
    const { seed, evidence } = heuristicSeed(fallbackBrief ?? material.slice(0, 400));
    return { label: `${label}-heuristic`, seed, evidence };
  };

  // ── collect contributions (modes compose; order = precedence, later wins) ──
  if (opts.fromProject !== undefined) {
    const dir = resolve(typeof opts.fromProject === "string" ? opts.fromProject : ".");
    const pm = projectMaterial(dir);
    if (!opts.json) {
      console.log(
        chalk.dim(
          `  reading ${pm.files.length} file(s) (${pm.files.join(", ") || "manifest only"}) · ~${Math.ceil(pm.chars / 4).toLocaleString()} tokens of input, bounded: never the whole project`,
        ),
      );
    }
    contributions.push(await extractOr(pm.material, `project:${basename(dir)}`));
  }
  if (opts.fromImport) {
    const path = resolve(opts.fromImport);
    // SOUL.md / a SoulSpec package dir (V3.3 embrace-extend) > character card > bare prompt.
    const isSoul = isSoulImport(path);
    const isCard = !isSoul && /\.(json|png)$/i.test(path);
    const material = isSoul
      ? importSoulMd(/(^|[\\/])SOUL\.md$/i.test(path) ? path : resolve(path, "SOUL.md"))
      : isCard
        ? importCharacterCard(path)
        : importPrompt(path);
    contributions.push({ label: `import:${material.format}`, seed: material.seed, evidence: material.evidence });
    // Prose refinement is LLM-only: the deterministic import fields are already
    // the trustworthy baseline, a no-model heuristic must never override them.
    if (material.prose.trim() && call) {
      try {
        const { seed, evidence } = await extractSeed(material.prose, `import-prose:${material.format}`, call);
        contributions.push({ label: `import-prose:${material.format}`, seed, evidence });
      } catch (e) {
        llmNotes.push(`extractor failed for import prose (${(e as Error).message}); card fields kept as-is`);
      }
    } else if (material.prose.trim()) {
      llmNotes.push("no model provider: card prose (personality/example dialogue) kept for later `personaxis decompile` refinement; deterministic fields used");
    }
  }
  if (opts.fromTranscript) {
    const text = readFileSync(resolve(opts.fromTranscript), "utf-8");
    contributions.push(await extractOr(text, `transcript:${basename(opts.fromTranscript)}`));
  }
  if (opts.fromPrompt) {
    contributions.push(await extractOr(opts.fromPrompt, "prompt", opts.fromPrompt));
  }
  if (contributions.length === 0) {
    if (!process.stdin.isTTY || opts.yes) {
      console.error(chalk.red("Error:"), "no input mode given and no TTY for the interview. Use --from-prompt/--from-project/--from-import/--from-transcript.");
      process.exit(1);
    }
    contributions.push(await runInterview(opts.deep ? "deep" : "core", process.cwd()));
  } else if (process.stdin.isTTY && !opts.yes && !opts.fromPrompt && contributions.every((c) => c.label.endsWith("heuristic"))) {
    // Nothing but defaults collected, offer the interview so numbers get earned.
    contributions.push(await runInterview(opts.deep ? "deep" : "core", process.cwd()));
  }

  if (slugArg) {
    contributions.push({ label: "cli-arg", seed: { slug: slugArg }, evidence: [] });
  }

  // ── build + gates ──────────────────────────────────────────────────────────
  const result: GenesisResult = genesis(contributions);
  const gates: Array<{ name: string; pass: boolean; detail: string }> = [];

  const validation = validatePersona(result.spec);
  gates.push({ name: "validate", pass: validation.valid, detail: validation.status });
  if (!validation.valid) {
    // Valid-by-construction is property-tested; reaching here is a bug, not a user error.
    console.error(chalk.red("✗ internal error:"), "Genesis produced an invalid spec, nothing was written. Please report this.");
    for (const e of validation.errors) console.error(`  ${chalk.red("✗")} ${e.field ?? ""} ${e.message}`);
    process.exit(exitCodeFor(validation.status));
  }

  const lint = runRules(result.spec as Record<string, unknown>).findings;
  const lintErrors = lint.filter((f) => f.severity === "error");
  gates.push({ name: "lint", pass: lintErrors.length === 0, detail: `${lintErrors.length} error(s), ${lint.length - lintErrors.length} warning(s)` });

  // Round-trip lite: the stage-1 assembler must accept the spec (compile gate).
  let compiled = "";
  try {
    compiled = assemblePersonaDoc({
      persona: result.spec,
      target: { name: (result.spec.identity as { display_name: string }).display_name, isSubagent: false, resourceBase: "./.personaxis/" },
    });
    gates.push({ name: "compile (stage-1)", pass: compiled.length > 0, detail: `${compiled.split("\n").length} lines` });
  } catch (e) {
    gates.push({ name: "compile (stage-1)", pass: false, detail: (e as Error).message });
  }
  // FASE 7 P1 hard gate (gap G1): no number leaves Genesis decorative. The
  // synthesis pass guarantees band prose; sigma = 0 here means a pipeline bug,
  // not a user error, exactly like valid-by-construction.
  try {
    const lookup = extractEnvelopes(result.spec as PersonaFrontmatter);
    // Zero-width envelopes are immutable by geometry: excluded, nothing to express.
    const decorative = Object.entries(lookup.envelopes)
      .filter(([, e]) => canCross(e) && staticallyDecorative(e))
      .map(([f]) => f);
    gates.push({
      name: "load-bearing (jacobian)",
      pass: decorative.length === 0,
      detail: decorative.length === 0 ? "0 decorative coordinates" : `${decorative.length} decorative: ${decorative.slice(0, 4).join(", ")}`,
    });
    if (decorative.length > 0) {
      console.error(chalk.red("✗ internal error:"), "Genesis produced decorative coordinates, nothing was written. Please report this.");
      for (const f of decorative) console.error(`  ${chalk.red("✗")} ${f} (σ=0: value cannot change the compiled artifact)`);
      process.exit(1);
    }
  } catch (e) {
    gates.push({ name: "load-bearing (jacobian)", pass: false, detail: (e as Error).message });
    console.error(chalk.red("✗ internal error:"), "load-bearing gate crashed, nothing was written.", (e as Error).message);
    process.exit(1);
  }
  for (const n of llmNotes) gates.push({ name: "provider", pass: true, detail: n });

  const slug = (result.spec.metadata as { name: string }).name;
  const baseDir = opts.root ? resolve(".personaxis") : resolve(".personaxis", "personas", slug);
  const personaPath = join(baseDir, "personaxis.md");
  if (existsSync(personaPath) && !opts.yes) {
    console.error(chalk.red("Error:"), `${relative(process.cwd(), personaPath)} already exists. Re-run with --yes to overwrite, or pass a different [slug].`);
    process.exit(1);
  }

  const summary = provenanceSummary(result.spec, result.ledger);
  const report = renderCreationReport(result, gates);

  if (opts.json) {
    console.log(JSON.stringify({ spec: result.spec, gates, provenance: summary, path: relative(process.cwd(), personaPath) }, null, 2));
    if (!opts.yes) return; // --json without --yes is a dry-run
  }

  // ── write artifacts ────────────────────────────────────────────────────────
  mkdirSync(baseDir, { recursive: true });
  writeFileSync(personaPath, result.document, "utf-8");
  writeFileSync(join(baseDir, "creation-report.md"), report, "utf-8");
  // The persona exists: the interview draft has served its purpose and must not linger as
  // a stale offer to "resume" an interview that already produced a persona.
  clearDraft(process.cwd());
  const handle = loadPersona(personaPath);
  ensureState(handle);
  const compiledPath = opts.root ? resolve("PERSONA.md") : join(baseDir, "PERSONA.md");
  if (compiled) writeFileSync(compiledPath, compiled.trimEnd() + "\n", "utf-8");

  // Creation is NOT done at the template. The stage-1 assembly echoes the answers back
  // almost verbatim, language included, so a persona created with a model configured must
  // pass through that model. Template output is a legitimate result ONLY with no model
  // reachable, and it is marked as such.
  //
  // Reporting this used to be wrong in a way that mattered: `runCompile` returned nothing,
  // so "it did not throw" was read as "a model rewrote it", and `create` printed
  // "compiled + LLM polished" over a template whenever the faithfulness gate rejected the
  // model's rewrite. It now asks for the outcome and says exactly what happened.
  let polished = false;
  let unpolishedReason: string | undefined;
  const wantPolish = opts.polish !== false && !opts.noPolish;
  const hasModel = !!resolveModel({ cwd: process.cwd(), personaPath });
  if (wantPolish && hasModel) {
    try {
      const outcome = await runCompile(opts.root ? { root: true } : { slug });
      polished = outcome.polished;
      if (!polished) unpolishedReason = outcome.via;
    } catch (e) {
      unpolishedReason = (e as Error).message;
    }
  }
  if (!polished && compiled) {
    const why = !wantPolish
      ? "polish skipped (--no-polish)"
      : !hasModel
        ? "no model configured"
        : (unpolishedReason ?? "the model's rewrite was not accepted");
    writeFileSync(
      compiledPath,
      compiled.trimEnd() + `\n\n<!-- stage-1 template, not polished by a model: ${why}. Run \`personaxis compile\` once that is resolved. -->\n`,
      "utf-8",
    );
  }

  if (!opts.json) {
    console.log("");
    console.log(chalk.green("✓"), chalk.bold(slug), "created, a governed persona, not a prose blob:");
    console.log(`  ${chalk.cyan(relative(process.cwd(), personaPath))} ${chalk.dim("(validated " + validation.status + ")")}`);
    const docNote = polished
      ? chalk.dim("(compiled + LLM polished)")
      : hasModel
        ? chalk.yellow("(stage-1 template, NOT polished)")
        : chalk.dim("(compiled, stage-1 offline; next compile with a model polishes it)");
    console.log(`  ${chalk.cyan(relative(process.cwd(), compiledPath))} ${docNote}`);
    console.log(`  ${chalk.cyan(relative(process.cwd(), handle.statePath))} ${chalk.dim("(runtime state)")}`);
    console.log(`  ${chalk.cyan(relative(process.cwd(), join(baseDir, "creation-report.md")))} ${chalk.dim(`(provenance: ${summary.covered.length}/${summary.quantitativeFields.length} fields, ${summary.defaultsOnly.length} default(s) to review)`)}`);
    const warns = lint.filter((f) => f.severity === "warning").length;
    if (warns) console.log(chalk.dim(`  ${warns} lint warning(s), run \`personaxis lint\` for detail (decorative numbers are worth fixing).`));
    console.log(
      chalk.dim(
        polished
          ? `\n  Next: personaxis state drift -f ${relative(process.cwd(), personaPath)} · talk to it: personaxis --persona ${relative(process.cwd(), personaPath)}`
          : `\n  Next: personaxis compile ${opts.root ? "--root" : slug}  (LLM polish once a model is configured) · personaxis state drift -f ${relative(process.cwd(), personaPath)}`,
      ),
    );
  }

  // A template produced WITH a model available is a defect, not a soft outcome: the user
  // asked for a persona and got their own answers echoed back. Say so on stderr, LAST, so
  // it is the line they leave with. The spec and state are already written and valid, so
  // nothing is lost by finishing, but nobody should read this run as a success.
  if (wantPolish && hasModel && !polished) {
    console.error("");
    console.error(chalk.red("  ✗ the document was NOT polished by a model, though one is configured."));
    console.error(chalk.dim(`    reason:  ${unpolishedReason ?? "unknown"}`));
    console.error(chalk.dim("    written: the deterministic stage-1 assembly, marked as such in the file."));
    console.error(chalk.dim(`    fix:     personaxis compile ${opts.root ? "--root" : slug}   (after resolving the reason above)`));
  }
}

export const createCommand = new Command("create")
  .description("Genesis: create a governed AI Persona from zero, interview, natural language, project scan, character-card/system-prompt import, or transcripts. Always validated; provenance per number.")
  .argument("[slug]", "Persona slug (default: derived from its name; created under .personaxis/personas/<slug>/)")
  .option("--from-prompt <brief>", "Create from a natural-language brief")
  .option("--from-project [dir]", "Infer the persona from a project's own docs (README, CLAUDE.md, …)")
  .option("--from-import <file>", "Import a SOUL.md / SoulSpec package dir, character card (.json/.png V2/V3), system prompt, or CLAUDE.md/AGENTS.md")
  .option("--from-transcript <file>", "Induce the persona that best explains exemplar conversations")
  .option("--root", "Create as the project's ROOT persona (.personaxis/personaxis.md + repo PERSONA.md)")
  .option("--yes", "Non-interactive: accept labeled defaults, overwrite existing files")
  .option("--json", "Emit the spec + gates + provenance as JSON (dry-run unless --yes)")
  .option("--provider <name>", "Override the configured provider (local | byok | agent | remote)")
  .option("--no-polish", "Skip the automatic LLM polish after creation (offline template, marked pending)")
  .option("--deep", "Ask the FULL question bank (envelope width, mood half-life, refusals, uncertainty, memory, improvement, a voice exemplar) instead of the twelve core questions")
  .action(async (slug: string | undefined, opts: CreateOpts) => {
    try {
      await runCreate(slug, opts);
    } catch (err) {
      console.error(chalk.red("Error:"), (err as Error).message);
      process.exit(1);
    }
  });
