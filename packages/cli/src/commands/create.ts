/**
 * `personaxis create`, Genesis: a governed AI Persona authored by a model from its sources
 * (docs/architecture/genesis.md):
 *
 *   personaxis create                          # pick a source, or start from the interview (TTY)
 *   personaxis create --from-prompt "<brief>"  # natural language
 *   personaxis create --from-project [dir]     # the project's own docs
 *   personaxis create --from-import <file>     # SOUL.md / SoulSpec dir, character card V2/V3 (.json/.png),
 *                                              # system prompt, CLAUDE.md/AGENTS.md
 *   personaxis create --from-transcript <file> # exemplar conversations
 *   --research                                 # plus the field, read on the web, with URLs and dates
 *
 * Every mode is a source; the modes compose. In a terminal, a model then interviews the person about what the
 * sources leave open (`runInterview`, up to 15 questions it writes for the job). A model authors the persona
 * stage by stage and every field
 * says which source it came from or what it was inferred from (`authorPersona`). Without a model, nothing
 * is created: since 2026-10-07 there is no template and no labeled default to fall back on. Output:
 * personaxis.md (validated), state.json, the compiled PERSONA.md, and creation-report.md.
 */

import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, relative, basename } from "node:path";
import chalk from "chalk";
import {
  isGenesisProfile,
  GENESIS_PROFILES,
  runInterview,
  interviewAsSource,
  sourcesFingerprint,
  INTERVIEW_LIMIT,
  loadDraft,
  saveDraft,
  clearDraft,
  importCharacterCard,
  importPrompt,
  importSoulMd,
  isSoulImport,
  numberSources,
  authorPersona,
  renderCreationReport,
  loadPersona,
  ensureState,
  assemblePersonaDoc,
  extractEnvelopes,
  staticallyDecorative,
  canCross,
  resolveModel,
  ModelRequiredError,
  RESEARCH_QUERIES_INSTRUCTION,
  RESEARCH_QUERIES_SCHEMA,
  findingsFrom,
  parseQueries,
  referenceName,
  renderReferenceNote,
  researchSources,
  resolveWebSearch,
  type Finding,
  type PersonaFrontmatter,
  type Source,
  type StructuredCaller,
  type InterviewQuestion,
  type InterviewTurn,
  type Reply,
} from "@personaxis/core";
import { dump } from "js-yaml";
import { runCompile } from "./compile.js";
import { validatePersona, exitCodeFor } from "../schema.js";
import { runRules } from "../linter/rules.js";
import { buildResourceManifest } from "../resource-manifest.js";
import { resolveProvider, type ProviderName } from "../providers/index.js";
import { ProviderRequiresAgentError } from "../providers/types.js";
import { movePersonaHistoryAside } from "../persona-history.js";

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
  /** E65: research the field on the web and leave what it found behind the persona. */
  research?: boolean;
  /** E128: the starting profile, the defaults of the three controls (range, per-layer policy, half-life). */
  profile?: string;
}

/** Provider adapter → core's StructuredCaller. Null when no model is usable. */
function structuredCaller(name?: ProviderName): StructuredCaller | null {
  try {
    const provider = resolveProvider(name);
    // E175: `agent` used to return null here, which sent `create --provider agent` down the
    // no-model path and built the persona from labeled defaults. It goes through the text path
    // like any provider without structured output; the agent provider writes the prompt for the
    // coding agent and `create` stops until the answer exists (see the action's catch).
    // Only when asked for by name: `agent` is also what resolves when no model is configured, and a
    // persona nobody asked a coding agent to author is a persona that needs a model configured.
    if (provider.name === "agent" && name !== "agent") return null;
    if (provider.runStructured) {
      return (prompt, schema, schemaName) => provider.runStructured!(prompt, schema, schemaName).then((r) => r.json);
    }
    return async (prompt, schema) => {
      const shape = schema ? `\n\nThe object must satisfy this JSON Schema:\n${JSON.stringify(schema)}` : "";
      const r = await provider.run(prompt + shape + "\n\nReturn ONLY a JSON object, no prose, no fences.");
      return JSON.parse(r.text.trim().replace(/^```[a-zA-Z]*\s*\n?|\n?```$/g, "")) as unknown;
    };
  } catch {
    return null;
  }
}

/**
 * One round of questions in the terminal: the Ink wizard when it can run, readline otherwise
 * (PERSONAXIS_NO_WIZARD=1 forces it). Lazy import: Ink costs about a second and only the interview pays it.
 */
async function askRound(questions: InterviewQuestion[], asked: number): Promise<Reply[]> {
  if (process.env.PERSONAXIS_NO_WIZARD !== "1") {
    try {
      const { runInterviewWizard } = await import("@personaxis/tui");
      return await runInterviewWizard(questions, asked, INTERVIEW_LIMIT);
    } catch {
      /* fall through to readline */
    }
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const replies: Reply[] = [];
  try {
    for (const [i, q] of questions.entries()) {
      console.log(chalk.dim(`\n  ${asked + i + 1}. ${q.why}`));
      console.log(chalk.cyan(`  ${q.question}`));
      q.options?.forEach((o, n) => console.log(`    ${chalk.dim(`${n + 1}.`)} ${o}`));
      const raw = (await rl.question(chalk.dim("  (Enter skips, q leaves) > "))).trim();
      if (raw === "q") return [...replies, { stop: true }];
      const picked = q.options && /^[1-9]$/.test(raw) ? q.options[Number(raw) - 1] : undefined;
      replies.push(raw ? { answer: picked ?? raw } : { skip: true });
    }
  } finally {
    rl.close();
  }
  return replies;
}

/**
 * The interview, after the sources are read: a model asks only what they leave open (`runInterview` in
 * core), resumable. The turns are written to a draft as they are given, kept with a fingerprint of the
 * sources, so leaving part-way does not lose them; the draft is deleted once the persona exists.
 */
async function interview(sources: Array<Omit<Source, "id">>, call: StructuredCaller, dir: string): Promise<InterviewTurn[]> {
  const print = sourcesFingerprint(sources);
  let turns: InterviewTurn[] = [];
  const resumed = loadDraft(dir, print);
  if (resumed) {
    const answered = resumed.turns.filter((t) => t.answer !== undefined).length;
    console.log(chalk.yellow(`\n  An unfinished interview was found: ${answered} answered of ${resumed.turns.length} asked `) + chalk.dim(`(${resumed.updated.slice(0, 16).replace("T", " ")}).`));
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let keep = "y";
    try {
      keep = ((await rl.question(`  Continue where you left off? ${chalk.dim("[Y/n]")} `)) || "y").trim().toLowerCase();
    } finally {
      rl.close();
    }
    if (keep === "y" || keep === "yes") turns = resumed.turns;
    else clearDraft(dir);
  }
  console.log(chalk.dim(`\n  The model reads ${sources.length ? "your sources" : "what you tell it"} and asks only what is missing (at most ${INTERVIEW_LIMIT} questions; skip any, and it infers it and says from what).`));
  return runInterview({
    sources: numberSources(sources),
    call,
    turns,
    ask: askRound,
    onTurn: (t) => saveDraft(dir, print, t),
    onRound: (r) => {
      if (!r.questions.length) console.log(chalk.dim("  Nothing more to ask: the rest can be inferred from what you gave."));
    },
  });
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
      { value: "interview", title: "Answer questions", desc: "a model asks about the job, only what it needs, at most 15; skip any" },
      { value: "prompt", title: "Describe it in a sentence", desc: "a brief; then the model asks about what it leaves open" },
      { value: "project", title: "Infer it from this project", desc: "reads only README / CLAUDE.md / AGENTS.md / SOUL.md, within a fixed budget" },
      { value: "import", title: "Import an existing one", desc: "SOUL.md, a character card (V2/V3), a system prompt, CLAUDE.md or AGENTS.md" },
      { value: "transcript", title: "Induce it from transcripts", desc: "the persona that best explains example conversations" },
    ],
    "up/down choose - Enter confirm - Esc cancel - every path ends in a validated, governed spec",
  );
  if (!choice) return false;
  if (choice === "interview") return true;
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
  // E128: refused before anything is asked or written, so a typo never becomes a Standard persona in silence.
  if (opts.profile !== undefined && !isGenesisProfile(opts.profile)) {
    throw new Error(`--profile must be one of ${GENESIS_PROFILES.join(", ")}; got '${opts.profile}'.`);
  }
  // No source flag and a terminal to ask in: show the sources instead of assuming one.
  const noSource = !opts.fromPrompt && opts.fromProject === undefined && !opts.fromImport && !opts.fromTranscript;
  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY && !opts.yes && !opts.json;
  if (noSource && interactive) {
    if (!(await chooseSource(opts))) {
      console.log(chalk.dim("  Cancelled; nothing was written."));
      return;
    }
  }

  const call = structuredCaller(opts.provider);
  // A persona is a model's work or it is not made: refused before anything is read or asked.
  if (!call) throw new ModelRequiredError("Creating a persona");
  const gathered: Array<Omit<Source, "id">> = [];
  const llmNotes: string[] = [];

  // ── collect the sources (they compose) ─────────────────────────────────────
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
    gathered.push({ kind: "project", label: `project ${basename(dir)}`, text: pm.material });
  }
  if (opts.fromImport) {
    const path = resolve(opts.fromImport);
    const isSoul = isSoulImport(path);
    const isCard = !isSoul && /\.(json|png)$/i.test(path);
    const material = isSoul
      ? importSoulMd(/(^|[\\/])SOUL\.md$/i.test(path) ? path : resolve(path, "SOUL.md"))
      : isCard
        ? importCharacterCard(path)
        : importPrompt(path);
    gathered.push({ kind: "import", label: `${basename(path)} (${material.format})`, text: material.text });
  }
  if (opts.fromTranscript) {
    gathered.push({ kind: "transcript", label: basename(opts.fromTranscript), text: readFileSync(resolve(opts.fromTranscript), "utf-8") });
  }
  if (opts.fromPrompt) gathered.push({ kind: "brief", label: "the brief", text: opts.fromPrompt });
  if (gathered.length === 0 && !interactive) {
    console.error(chalk.red("Error:"), "no source given and no terminal for the interview. Use --from-prompt/--from-project/--from-import/--from-transcript.");
    process.exitCode = 1;
    return;
  }

  // ── the interview: what the sources leave open, asked by the model (never with --yes or --json) ──
  let turns: InterviewTurn[] = [];
  if (interactive) {
    turns = await interview(gathered, call, process.cwd());
    const answers = interviewAsSource(turns);
    if (answers) gathered.push(answers);
  }
  if (gathered.length === 0) {
    console.error(chalk.red("Error:"), "the interview was left empty; there is nothing to author a persona from.");
    process.exitCode = 1;
    return;
  }

  // ── E65: the web research, only when asked for ─────────────────────────────
  //
  // What the pages said becomes sources the model may cite for knowledge and procedures; `checkStage`
  // rejects a web source as the origin of the identity, the character or a hard limit. Each result passes
  // `ingestUntrusted` inside `findingsFrom`, because this command is not the agent loop.
  let researchNote: { name: string; content: string } | null = null;
  if (opts.research) {
    const provider = resolveWebSearch({ cwd: process.cwd() });
    const brief = gathered.map((g) => g.text).join("\n\n").slice(0, 4000);
    if (!provider) {
      llmNotes.push("no web search provider available (no key); nothing was researched");
    } else {
      const said = (await call(`${RESEARCH_QUERIES_INSTRUCTION}\n\nBRIEF:\n${brief}`, RESEARCH_QUERIES_SCHEMA, "research_queries")) as { queries?: string[] };
      const queries = parseQueries((said?.queries ?? []).join("\n"));
      const findings: Finding[] = [];
      for (const query of queries) {
        try {
          // `advanced` buys better excerpts, which is what makes reading a URL unnecessary here: the provider
          // returns each page's relevant text already cleaned, and fetching a named host is refused by design.
          findings.push(...findingsFrom(query, await provider.search(query, { maxResults: 6, depth: "advanced" })));
        } catch (e) {
          llmNotes.push(`the web search failed for "${query}" (${(e as Error).message})`);
        }
      }
      if (findings.length === 0) {
        llmNotes.push("the web search returned nothing usable; nothing was researched");
      } else {
        const now = new Date();
        const name = referenceName(now);
        researchNote = { name, content: renderReferenceNote(findings, { provider: provider.name, now, brief: opts.fromPrompt }) };
        gathered.push(...researchSources(findings, now));
        console.log(chalk.dim(`  researched ${queries.length} quer${queries.length === 1 ? "y" : "ies"}, kept ${findings.length} source(s) in references/${name}`));
      }
    }
  }

  // ── author: one model call per stage, every field with its provenance ──────
  const sources = numberSources(gathered);
  if (!opts.json) console.log(chalk.dim(`  authoring from ${sources.length} source(s), one model call per stage…`));
  const authored = await authorPersona({ sources, call, profile: opts.profile ?? "standard", ...(slugArg ? { canonicalId: slugArg } : {}) });
  const spec = authored.spec;
  if (researchNote) spec.extensions = { ...((spec.extensions as Record<string, unknown>) ?? {}), references: [`references/${researchNote.name}`] };
  const document = `---\n${dump(spec, { lineWidth: 100, noRefs: true })}---\n\n## Overview\n\n${(spec.metadata as { description: string }).description}\n\n## Sources\n\n${sources.map((s) => `- ${s.id}: ${s.label}${s.url ? ` (${s.url})` : ""}`).join("\n")}\n\nWhere every field came from is in \`creation-report.md\`.\n`;
  const gates: Array<{ name: string; pass: boolean; detail: string }> = [];

  const validation = validatePersona(spec);
  gates.push({ name: "validate", pass: validation.valid, detail: validation.status });
  if (!validation.valid) {
    // The author validates every stage and the whole document; reaching here is a bug, not a user error.
    console.error(chalk.red("✗ internal error:"), "Genesis produced an invalid spec, nothing was written. Please report this.");
    for (const e of validation.errors) console.error(`  ${chalk.red("✗")} ${e.field ?? ""} ${e.message}`);
    process.exitCode = exitCodeFor(validation.status);
    return;
  }

  const lint = runRules(spec as Record<string, unknown>).findings;
  const lintErrors = lint.filter((f) => f.severity === "error");
  // Warnings only: this counted every non-error finding, info included, so the report said 3 where the
  // terminal, counting warnings, said 1 (2026-10-03).
  const lintWarnings = lint.filter((f) => f.severity === "warning").length;
  gates.push({ name: "lint", pass: lintErrors.length === 0, detail: `${lintErrors.length} error(s), ${lintWarnings} warning(s)` });

  // Round-trip lite: the stage-1 assembler must accept the spec (compile gate).
  let compiled = "";
  try {
    compiled = assemblePersonaDoc({
      persona: spec,
      target: { name: (spec.identity as { display_name: string }).display_name, isSubagent: false, resourceBase: "./.personaxis/" },
    });
    gates.push({ name: "compile (stage-1)", pass: compiled.length > 0, detail: `${compiled.split("\n").length} lines` });
  } catch (e) {
    gates.push({ name: "compile (stage-1)", pass: false, detail: (e as Error).message });
  }
  // FASE 7 P1 hard gate (gap G1): no number leaves Genesis decorative. Every stage checks that its
  // numbers can cross a band and carries band prose; sigma = 0 here means a pipeline bug.
  try {
    const lookup = extractEnvelopes(spec as PersonaFrontmatter);
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
      process.exitCode = 1;
      return;
    }
  } catch (e) {
    gates.push({ name: "load-bearing (jacobian)", pass: false, detail: (e as Error).message });
    console.error(chalk.red("✗ internal error:"), "load-bearing gate crashed, nothing was written.", (e as Error).message);
    process.exitCode = 1;
    return;
  }

  const slug = (spec.metadata as { name: string }).name;
  const baseDir = opts.root ? resolve(".personaxis") : resolve(".personaxis", "personas", slug);
  const personaPath = join(baseDir, "personaxis.md");
  if (existsSync(personaPath) && !opts.yes) {
    console.error(chalk.red("Error:"), `${relative(process.cwd(), personaPath)} already exists. Re-run with --yes to overwrite, or pass a different [slug].`);
    process.exitCode = 1;
    return;
  }

  const model = opts.provider === "agent" ? "the coding agent (--provider agent)" : resolveModel({ cwd: process.cwd() })?.model;
  const report = renderCreationReport(authored, sources, gates, { notes: llmNotes, interview: turns, ...(model ? { model } : {}) });
  const inferredCount = authored.stages.flatMap((st) => st.provenance).filter((p) => !p.quote && p.inferred).length;

  if (opts.json) {
    console.log(JSON.stringify({ spec, gates, notes: llmNotes, sources, stages: authored.stages, path: relative(process.cwd(), personaPath) }, null, 2));
    if (!opts.yes) return; // --json without --yes is a dry-run
  }

  // ── write artifacts ────────────────────────────────────────────────────────
  // Replacing an existing persona starts a new one: what the old one lived (state, record, memory,
  // sessions, self-edits) is moved aside, or the new definition would start from the old values (E176).
  const previousHistory = existsSync(personaPath) ? movePersonaHistoryAside(personaPath) : undefined;
  mkdirSync(baseDir, { recursive: true });
  writeFileSync(personaPath, document, "utf-8");
  writeFileSync(join(baseDir, "creation-report.md"), report, "utf-8");
  // E65: the note goes where `extensions.references` says it is.
  if (researchNote) {
    mkdirSync(join(baseDir, "references"), { recursive: true });
    writeFileSync(join(baseDir, "references", researchNote.name), researchNote.content, "utf-8");
  }
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
    // With --json, stdout is the JSON already printed: compile's progress goes to stderr, or a script
    // parsing the output reads the JSON followed by a line of text (seen 2026-10-07).
    const log = console.log;
    if (opts.json) console.log = console.error;
    try {
      const outcome = await runCompile(opts.root ? { root: true } : { slug });
      polished = outcome.polished;
      if (!polished) unpolishedReason = outcome.via;
    } catch (e) {
      unpolishedReason = (e as Error).message;
    } finally {
      console.log = log;
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
    console.log(`  ${chalk.cyan(relative(process.cwd(), join(baseDir, "creation-report.md")))} ${chalk.dim(`(where every field came from; ${inferredCount} inferred, read those first)`)}`);
    if (previousHistory) {
      console.log(`  ${chalk.cyan(relative(process.cwd(), previousHistory))} ${chalk.dim("(the replaced persona's state, record and memory, moved aside; the new one starts fresh)")}`);
    }
    const warns = lint.filter((f) => f.severity === "warning").length;
    if (warns) console.log(chalk.dim(`  ${warns} lint warning(s), run \`personaxis lint\` for detail (decorative numbers are worth fixing).`));
    // What was worked around (no model, a failed search) said where it happens, not only in the report.
    for (const note of llmNotes) console.log(chalk.yellow(`  ⚠ ${note}`));
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
  .description("Genesis: create a persona from nothing: an interview, a brief, a project scan, an imported card or system prompt, or transcripts. Always validated; provenance per number.")
  .argument("[slug]", "Persona slug (default: derived from its name; created under .personaxis/personas/<slug>/)")
  .option("--from-prompt <brief>", "Create from a natural-language brief")
  .option("--from-project [dir]", "Infer the persona from a project's own docs (README, CLAUDE.md, …)")
  .option("--from-import <file>", "Import a SOUL.md / SoulSpec package dir, character card (.json/.png V2/V3), system prompt, or CLAUDE.md/AGENTS.md")
  .option("--from-transcript <file>", "Induce the persona that best explains exemplar conversations")
  .option("--root", "Create as the project's ROOT persona (.personaxis/personaxis.md + repo PERSONA.md)")
  .option("--yes", "Non-interactive: never ask, and overwrite existing files")
  .option("--json", "Emit the spec + gates + provenance as JSON (dry-run unless --yes)")
  .option("--provider <name>", "Override the configured provider (local | byok | agent)")
  .option("--no-polish", "Skip the automatic LLM polish after creation (offline template, marked pending)")
  .option("--profile <name>", "Starting profile: regulated | standard | research (the defaults of each layer's range, who approves lasting changes, and how fast it returns to baseline). Default: standard")
  .option("--research", "Search the web for the field, and leave what it found in references/ with each source and its date (needs a web provider key)")
  .action(async (slug: string | undefined, opts: CreateOpts) => {
    try {
      await runCreate(slug, opts);
    } catch (err) {
      // E175: the prompt is waiting for the coding agent, as with `compile`: say where, exit 0.
      if (err instanceof ProviderRequiresAgentError) {
        console.log(err.message.replace("Then re-run this command with --from-file " + err.resultFile + " to apply the result.", "Then re-run this same command: it reads the answer and continues."));
        process.exit(0);
      }
      console.error(chalk.red("Error:"), (err as Error).message);
      // Not process.exit: a failure right after a model call leaves its socket closing, and exiting under
      // it aborts the process on Windows (libuv UV_HANDLE_CLOSING, 0xC0000409) instead of returning 1.
      process.exitCode = 1;
    }
  });
