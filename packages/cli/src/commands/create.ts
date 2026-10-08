/**
 * `personaxis init` and `personaxis create`, Genesis: an AI persona written by a model from what it can
 * read and what you tell it (docs/architecture/genesis.md). One process, in one order, whatever the case:
 *
 *   1. the folder you are in, always: its tree, the files that explain it and the personas already in it
 *      (`folderContext`; nothing in the home folder or an empty one);
 *   2. what you want, optional, in a sentence: the command's argument, or one question in a terminal;
 *   3. material you point at: `--from-import` (SOUL.md, a character card, a system prompt),
 *      `--from-transcript`, `--research`;
 *   4. the interview, in a terminal: the model asks only what all of that leaves open;
 *   5. the persona, stage by stage, the coherence reading, the gates, and PERSONA.md written by the model.
 *
 *   personaxis init ["what it is for"]           # this folder's persona (.personaxis/personaxis.md)
 *   personaxis create <name> ["what it is for"]  # another persona in this folder (.personaxis/personas/<name>/)
 *
 * Without a model nothing is created: there is no template and no default to fall back on (2026-10-07).
 */

import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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
import { resolveProvider, type ProviderName } from "../providers/index.js";
import { ProviderRequiresAgentError } from "../providers/types.js";
import { hasNotLived, movePersonaHistoryAside } from "../persona-history.js";

interface CreateOpts {
  /** What the persona is for, or anything to add: the command's argument. */
  intent?: string;
  fromImport?: string;
  fromTranscript?: string;
  root?: boolean;
  yes?: boolean;
  json?: boolean;
  provider?: ProviderName;
  /** Commander maps --no-compile onto compile:false: write the definition, leave PERSONA.md to `compile`. */
  compile?: boolean;
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

/** Folders that say nothing about what a project is, skipped in its tree. */
const SKIP = new Set([".git", "node_modules", "dist", "build", "out", "target", "vendor", ".venv", "venv", "__pycache__", ".next", ".turbo", "coverage", ".cache", ".idea", ".vscode"]);
/** The files that explain a project, in the order they are read, across ecosystems. */
const EXPLAINS = ["README.md", "README", "readme.md", "CLAUDE.md", "AGENTS.md", "SOUL.md", "CONTRIBUTING.md", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "Gemfile", "composer.json", "requirements.txt"];
const PER_FILE = 6000;
const TOTAL = 24_000;

/**
 * What the folder you are in says about itself, the way `/init` reads a repository before writing its
 * CLAUDE.md: a two-level tree, the files that explain the project (and up to three documents from `docs/`),
 * and the personas already living there with their purpose, so a new one knows its colleagues. Bounded: a
 * giant repository costs the same as a small one. Undefined in the home folder (a personal persona is not a
 * project's) and in a folder with nothing to read. `skip` leaves out the persona being created (its own
 * earlier write is not a colleague, and listing it changed every prompt of an agent's re-run) and a file
 * given with --from-import, which is read once, as the import.
 */
export function folderContext(dir: string, skip: readonly string[] = []): { text: string; files: string[] } | undefined {
  const skipped = new Set(skip.map((p) => resolve(p).toLowerCase()));
  const kept = (p: string): boolean => !skipped.has(resolve(p).toLowerCase());
  if (resolve(dir) === resolve(homedir())) return undefined;
  const list = (d: string): string[] => {
    try {
      return readdirSync(d, { withFileTypes: true })
        .filter((e) => !SKIP.has(e.name) && e.name !== ".personaxis")
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();
    } catch {
      return [];
    }
  };
  const top = list(dir);
  const tree = top.flatMap((entry) => [entry, ...(entry.endsWith("/") ? list(join(dir, entry)).slice(0, 12).map((c) => `  ${entry}${c}`) : [])]).slice(0, 80);
  const docs = existsSync(join(dir, "docs")) ? list(join(dir, "docs")).filter((f) => /\.md$/i.test(f)).slice(0, 3).map((f) => `docs/${f}`) : [];
  const parts: string[] = [];
  const files: string[] = [];
  let total = 0;
  // Matched against the real names, without regard to case and once each: on a case-insensitive disk
  // "README.md" and "readme.md" are one file, read twice before this (2026-10-08).
  const actual = new Map(top.filter((e) => !e.endsWith("/")).map((e) => [e.toLowerCase(), e]));
  const wanted = [...new Set([...EXPLAINS.map((f) => actual.get(f.toLowerCase())).filter((f): f is string => !!f), ...docs])];
  for (const f of wanted) {
    const path = join(dir, f);
    if (!kept(path) || !existsSync(path) || !statSync(path).isFile() || total >= TOTAL) continue;
    const chunk = readFileSync(path, "utf-8").slice(0, Math.min(PER_FILE, TOTAL - total));
    parts.push(`FILE ${f}:\n${chunk}`);
    files.push(f);
    total += chunk.length;
  }
  const personas = [join(dir, ".personaxis", "personaxis.md"), ...list(join(dir, ".personaxis", "personas")).filter((e) => e.endsWith("/")).map((e) => join(dir, ".personaxis", "personas", e, "personaxis.md"))]
    .filter((p) => existsSync(p) && kept(p))
    .map((p) => {
      const purpose = /purpose:\s*>?-?\s*\n?\s*(.+)/.exec(readFileSync(p, "utf-8"))?.[1]?.trim() ?? "(no purpose stated)";
      return `- ${relative(dir, p).replace(/\\/g, "/")}: ${purpose.slice(0, 200)}`;
    });
  if (!tree.length && !parts.length && !personas.length) return undefined;
  // Said in the source itself: measured 2026-10-08 on a copy of the spec package, without this line the model
  // made the persona the software ("Spec Validator") instead of the professional who works on it.
  const text = [
    `FOLDER ${basename(resolve(dir))}: the place this persona will work in. It describes the work, not the persona: unless the person says otherwise, the persona is the professional who does this folder's work (builds it, maintains it, reviews it, runs it), and never the software or the documents themselves.`,
    tree.length ? `TREE:\n${tree.join("\n")}` : "",
    ...parts,
    personas.length ? `PERSONAS ALREADY HERE:\n${personas.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return { text, files };
}

/** One line in a terminal: what the persona is for, or anything to add. Empty means nothing. */
async function askIntent(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(chalk.cyan("  What should this persona do, or anything to add? ") + chalk.dim("(Enter to let the model infer it) "))).trim();
  } finally {
    rl.close();
  }
}

export async function runCreate(slugArg: string | undefined, opts: CreateOpts): Promise<void> {
  // E128: refused before anything is asked or written, so a typo never becomes a Standard persona in silence.
  if (opts.profile !== undefined && !isGenesisProfile(opts.profile)) {
    throw new Error(`--profile must be one of ${GENESIS_PROFILES.join(", ")}; got '${opts.profile}'.`);
  }
  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY && !opts.yes && !opts.json;

  const call = structuredCaller(opts.provider);
  // A persona is a model's work or it is not made: refused before anything is read or asked.
  if (!call) throw new ModelRequiredError("Creating a persona");
  const gathered: Array<Omit<Source, "id">> = [];
  const llmNotes: string[] = [];

  // ── 1. the folder you are in, always ───────────────────────────────────────
  const target = opts.root ? resolve(".personaxis", "personaxis.md") : resolve(".personaxis", "personas", slugArg ?? "", "personaxis.md");
  const folder = folderContext(process.cwd(), [target, ...(opts.fromImport ? [resolve(opts.fromImport)] : [])]);
  if (folder) gathered.push({ kind: "project", label: `this folder (${basename(process.cwd())})`, text: folder.text });
  if (!opts.json) {
    console.log(
      chalk.dim(
        folder
          ? `  reading this folder: ${folder.files.length ? folder.files.join(", ") : "its tree"}, bounded, never the whole project`
          : "  no project here to read (the home folder or an empty one): the persona comes from what you say",
      ),
    );
  }

  // ── 2. what you want, optional ─────────────────────────────────────────────
  const intent = opts.intent?.trim() || (interactive ? await askIntent() : "");
  if (intent) gathered.push({ kind: "brief", label: "what you asked for", text: intent });

  // ── 3. material you point at ───────────────────────────────────────────────
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
  if (gathered.length === 0 && !interactive) {
    console.error(chalk.red("Error:"), "nothing to create from: no project here, no intent and no terminal for the interview. Say what the persona is for: personaxis init \"...\".");
    process.exitCode = 1;
    return;
  }

  // ── 4. the interview: what the sources leave open, asked by the model (never with --yes or --json) ──
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
        researchNote = { name, content: renderReferenceNote(findings, { provider: provider.name, now, ...(intent ? { brief: intent } : {}) }) };
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
    gates.push({ name: "PERSONA.md reference", pass: compiled.length > 0, detail: `${compiled.split("\n").length} lines` });
  } catch (e) {
    gates.push({ name: "PERSONA.md reference", pass: false, detail: (e as Error).message });
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
  // The same definition over a persona that has lived nothing is the same persona: the agent provider
  // re-runs `create` after every answer it writes, and each re-run must not archive the previous one.
  const rerun = existsSync(personaPath) && readFileSync(personaPath, "utf-8") === document && hasNotLived(personaPath);
  const previousHistory = existsSync(personaPath) && !rerun ? movePersonaHistoryAside(personaPath) : undefined;
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

  // PERSONA.md is written by the model and held to the reference by the faithfulness check
  // (`runCompile`); there is no template to fall back on. A failure leaves the definition, which is
  // valid, and says how to finish.
  let compileError: string | undefined;
  if (opts.compile !== false) {
    // With --json, stdout is the JSON already printed: compile's progress goes to stderr, or a script
    // parsing the output reads the JSON followed by a line of text (seen 2026-10-07).
    const log = console.log;
    if (opts.json) console.log = console.error;
    try {
      await runCompile({ ...(opts.root ? { root: true } : { slug }), ...(opts.provider ? { provider: opts.provider } : {}), cause: "creation" });
    } catch (e) {
      if (e instanceof ProviderRequiresAgentError) throw e; // the agent answers, then `create` runs again
      compileError = (e as Error).message;
    } finally {
      console.log = log;
    }
  }

  if (!opts.json) {
    console.log("");
    console.log(chalk.green("✓"), chalk.bold(slug), "created, a governed persona, not a prose blob:");
    console.log(`  ${chalk.cyan(relative(process.cwd(), personaPath))} ${chalk.dim("(validated " + validation.status + ")")}`);
    if (opts.compile !== false && !compileError) console.log(`  ${chalk.cyan(relative(process.cwd(), compiledPath))} ${chalk.dim("(written by the model, checked against the definition)")}`);
    console.log(`  ${chalk.cyan(relative(process.cwd(), handle.statePath))} ${chalk.dim("(runtime state)")}`);
    console.log(`  ${chalk.cyan(relative(process.cwd(), join(baseDir, "creation-report.md")))} ${chalk.dim(`(where every field came from; ${inferredCount} inferred, read those first)`)}`);
    if (previousHistory) {
      console.log(`  ${chalk.cyan(relative(process.cwd(), previousHistory))} ${chalk.dim("(the replaced persona's state, record and memory, moved aside; the new one starts fresh)")}`);
    }
    const warns = lint.filter((f) => f.severity === "warning").length;
    if (warns) console.log(chalk.dim(`  ${warns} lint warning(s), run \`personaxis lint\` for detail (decorative numbers are worth fixing).`));
    // What was worked around (a failed search) said where it happens, not only in the report.
    for (const note of llmNotes) console.log(chalk.yellow(`  ⚠ ${note}`));
    if (opts.compile === false) console.log(chalk.dim(`\n  PERSONA.md not written (--no-compile). Next: personaxis compile ${opts.root ? "--root" : slug}`));
    else if (!compileError) console.log(chalk.dim(`\n  Next: talk to it: personaxis --persona ${relative(process.cwd(), personaPath)}`));
  }

  // The definition is written and valid, but a persona without its document is not finished: say so on
  // stderr, last, so it is the line the person leaves with, and exit 1.
  if (compileError) {
    console.error("");
    console.error(chalk.red("  ✗ PERSONA.md was not written."));
    console.error(chalk.dim(`    reason: ${compileError}`));
    console.error(chalk.dim(`    finish: personaxis compile ${opts.root ? "--root" : slug}`));
    process.exitCode = 1;
  }
}

/** The options `init` and `create` share: everything after the folder and the intent. */
export function withGenesisOptions(command: Command): Command {
  return command
    .option("--from-import <file>", "Also read a SOUL.md or SoulSpec package, a character card (.json/.png V2/V3), a system prompt, or CLAUDE.md/AGENTS.md")
    .option("--from-transcript <file>", "Also read example conversations of how it should work")
    .option("--research", "Also search the web for the field, and keep what it found in references/ with each source and its date (needs a web provider key)")
    .option("--profile <name>", "Starting stance: regulated | standard | research (how far values move, how fast they return, who approves lasting changes). Default: standard")
    .option("--yes", "Never ask (no interview), and overwrite existing files")
    .option("--json", "Emit the spec + gates + sources + stages as JSON (dry-run unless --yes)")
    .option("--provider <name>", "Override the configured provider (local | byok | agent)")
    .option("--no-compile", "Write the definition only; PERSONA.md comes later with `personaxis compile`");
}

/** Run Genesis from a command, with the agent handoff and the exit code every caller needs. */
export async function runGenesisCommand(slug: string | undefined, opts: CreateOpts): Promise<void> {
  try {
    await runCreate(slug, opts);
  } catch (err) {
    // E175: the prompt is waiting for the coding agent, as with `compile`: say where, exit 0.
    if (err instanceof ProviderRequiresAgentError) {
      console.log(err.message.replace("Then re-run this command with --from-file " + err.resultFile + " to apply the result.", "Then re-run this same command: it reads the answer and continues."));
      return;
    }
    console.error(chalk.red("Error:"), (err as Error).message);
    // Not process.exit: a failure right after a model call leaves its socket closing, and exiting under
    // it aborts the process on Windows (libuv UV_HANDLE_CLOSING, 0xC0000409) instead of returning 1.
    process.exitCode = 1;
  }
}

export const createCommand = withGenesisOptions(
  new Command("create")
    .description("Create another persona in this folder (.personaxis/personas/<name>/): a model reads the folder, asks what is missing and writes it")
    .argument("<name>", "Its name in this folder: .personaxis/personas/<name>/")
    .argument("[intent...]", "What it is for, or anything to add (optional)"),
).action(async (name: string, intent: string[], opts: CreateOpts) => runGenesisCommand(name, { ...opts, intent: intent.join(" ") }));
