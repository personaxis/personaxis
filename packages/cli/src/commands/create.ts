/**
 * `personaxis create` — Genesis: a governed AI Persona from zero, every entry
 * case covered (docs/architecture/genesis.md):
 *
 *   personaxis create                          # psychometric interview (TTY)
 *   personaxis create --from-prompt "<brief>"  # natural language
 *   personaxis create --from-project [dir]     # infer from the project's docs
 *   personaxis create --from-import <file>     # character card V2/V3 (.json/.png),
 *                                              # system prompt, CLAUDE.md/AGENTS.md
 *   personaxis create --from-transcript <file> # exemplar conversations
 *
 * Modes COMPOSE (later evidence wins per field; the report shows overrides).
 * Output is never a prose blob: personaxis.md (validated PASS — Genesis never
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
  importCharacterCard,
  importPrompt,
  extractSeed,
  heuristicSeed,
  renderCreationReport,
  provenanceSummary,
  loadPersona,
  ensureState,
  assemblePersonaDoc,
  type SeedContribution,
  type StructuredCaller,
  type InterviewAnswers,
  type GenesisResult,
} from "@personaxis/core";
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

async function runInterview(): Promise<SeedContribution> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answers: InterviewAnswers = {};
  console.log(chalk.bold("\nGenesis interview") + chalk.dim(" — every answer becomes auditable evidence; Enter skips a question.\n"));
  try {
    for (const item of pendingItems(answers)) {
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
    }
  } finally {
    rl.close();
  }
  const { seed, evidence } = applyAnswers(answers);
  return { label: "interview", seed, evidence };
}

/** Gather the project's own words: README + docs + agent files (capped). */
function projectMaterial(dir: string): string {
  const parts: string[] = [`RESOURCE MANIFEST:\n${buildResourceManifest(dir) ?? "(none)"}`];
  for (const f of ["README.md", "CLAUDE.md", "AGENTS.md", "package.json", "docs/HOW_IT_WORKS.md"]) {
    const p = join(dir, f);
    if (existsSync(p)) parts.push(`FILE ${f}:\n${readFileSync(p, "utf-8").slice(0, 6000)}`);
  }
  return parts.join("\n\n");
}

export async function runCreate(slugArg: string | undefined, opts: CreateOpts): Promise<void> {
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
    contributions.push(await extractOr(projectMaterial(dir), `project:${basename(dir)}`));
  }
  if (opts.fromImport) {
    const path = resolve(opts.fromImport);
    const isCard = /\.(json|png)$/i.test(path);
    const material = isCard ? importCharacterCard(path) : importPrompt(path);
    contributions.push({ label: `import:${material.format}`, seed: material.seed, evidence: material.evidence });
    // Prose refinement is LLM-only: the deterministic import fields are already
    // the trustworthy baseline — a no-model heuristic must never override them.
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
    contributions.push(await runInterview());
  } else if (process.stdin.isTTY && !opts.yes && !opts.fromPrompt && contributions.every((c) => c.label.endsWith("heuristic"))) {
    // Nothing but defaults collected — offer the interview so numbers get earned.
    contributions.push(await runInterview());
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
    console.error(chalk.red("✗ internal error:"), "Genesis produced an invalid spec — nothing was written. Please report this.");
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
  const handle = loadPersona(personaPath);
  ensureState(handle);
  const compiledPath = opts.root ? resolve("PERSONA.md") : join(baseDir, "PERSONA.md");
  if (compiled) writeFileSync(compiledPath, compiled.trimEnd() + "\n", "utf-8");

  if (!opts.json) {
    console.log("");
    console.log(chalk.green("✓"), chalk.bold(slug), "created — a governed persona, not a prose blob:");
    console.log(`  ${chalk.cyan(relative(process.cwd(), personaPath))} ${chalk.dim("(validated " + validation.status + ")")}`);
    console.log(`  ${chalk.cyan(relative(process.cwd(), compiledPath))} ${chalk.dim("(compiled, stage-1)")}`);
    console.log(`  ${chalk.cyan(relative(process.cwd(), handle.statePath))} ${chalk.dim("(runtime state)")}`);
    console.log(`  ${chalk.cyan(relative(process.cwd(), join(baseDir, "creation-report.md")))} ${chalk.dim(`(provenance: ${summary.covered.length}/${summary.quantitativeFields.length} fields, ${summary.defaultsOnly.length} default(s) to review)`)}`);
    const warns = lint.filter((f) => f.severity === "warning").length;
    if (warns) console.log(chalk.dim(`  ${warns} lint warning(s) — run \`personaxis lint\` for detail (decorative numbers are worth fixing).`));
    console.log(chalk.dim(`\n  Next: personaxis compile ${opts.root ? "--root" : slug}  (LLM polish) · personaxis state drift -f ${relative(process.cwd(), personaPath)}`));
  }
}

export const createCommand = new Command("create")
  .description("Genesis: create a governed AI Persona from zero — interview, natural language, project scan, character-card/system-prompt import, or transcripts. Always validated; provenance per number.")
  .argument("[slug]", "Persona slug (default: derived from its name; created under .personaxis/personas/<slug>/)")
  .option("--from-prompt <brief>", "Create from a natural-language brief")
  .option("--from-project [dir]", "Infer the persona from a project's own docs (README, CLAUDE.md, …)")
  .option("--from-import <file>", "Import a character card (.json/.png V2/V3), system prompt, or CLAUDE.md/AGENTS.md")
  .option("--from-transcript <file>", "Induce the persona that best explains exemplar conversations")
  .option("--root", "Create as the project's ROOT persona (.personaxis/personaxis.md + repo PERSONA.md)")
  .option("--yes", "Non-interactive: accept labeled defaults, overwrite existing files")
  .option("--json", "Emit the spec + gates + provenance as JSON (dry-run unless --yes)")
  .option("--provider <name>", "Override the configured provider (local | byok | agent | remote)")
  .action(async (slug: string | undefined, opts: CreateOpts) => {
    try {
      await runCreate(slug, opts);
    } catch (err) {
      console.error(chalk.red("Error:"), (err as Error).message);
      process.exit(1);
    }
  });
