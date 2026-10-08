import { Command } from "commander";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname, relative, join } from "path";
import chalk from "chalk";
import { loadPersonaFile, resolvePersonaSourcePath, compiledPathFor, isSubagentPath, slugAddressFromPath } from "../load.js";
import { validatePersona } from "../schema.js";
import { injectBaselineIntoClaude } from "../targets/claude-code.js";
import { injectBaselineIntoAgents } from "../targets/codex.js";
import {
  activeOverlay,
  readRecompilePending,
  clearRecompilePending,
  assemblePersonaDoc,
  checkFaithfulness,
  distSlices,
  ModelRequiredError,
  DIST_HOT_FILE,
  DIST_COLD_FILE,
  recordCompiled,
  compiledHistory,
  ensureState,
  loadPersona,
} from "@personaxis/core";
import { buildWritePrompt, type CompileTargetInfo } from "../compile-instructions.js";
import { ProviderRequiresAgentError, type ProviderRunResult } from "../providers/types.js";
import { resolveProvider, type ProviderName } from "../providers/index.js";
import { hashContent, saveManifest } from "../manifest.js";
import { placeCompiledDocument, isSoulPlatform, PLACEMENT_PLATFORMS, type PlacementPlatform } from "../targets/placement.js";
import { resolveDeclaredSkills, materializeLocalSkills, writeSkillsManifest } from "../targets/skills.js";
import { assembleInputFor, dressCompiledDocument } from "../compiled-document.js";
import { holdPresence } from "../presence-session.js";

/** Values block of a state.json payload, or undefined when absent/malformed. */
function parseStateValues(stateJson: string | undefined): Record<string, number> | undefined {
  if (!stateJson) return undefined;
  try {
    const v = (JSON.parse(stateJson) as { values?: Record<string, unknown> }).values;
    if (!v || typeof v !== "object") return undefined;
    const out: Record<string, number> = {};
    for (const [k, n] of Object.entries(v)) if (typeof n === "number") out[k] = n;
    return out;
  } catch {
    return undefined; // a torn state.json must not break compile; means apply
  }
}

function readSibling(baseDir: string, name: string): string | undefined {
  const p = join(baseDir, name);
  return existsSync(p) ? readFileSync(p, "utf-8") : undefined;
}

/**
 * Refresh the root baseline files that point a host at PERSONA.md.
 *
 * Default policy (no `--platform`): update whichever baselines already exist, and create
 * CLAUDE.md only when the project has none, so we never litter a project with baselines
 * for hosts it does not use.
 *
 * With an explicit `--platform`, that host's baseline is CREATED if missing. Asking to
 * compile for codex and getting a CLAUDE.md instead of an AGENTS.md left the main persona
 * unreachable from Codex while the command reported success: an explicit request is not a
 * guess to be defaulted away. (Found by dogfooding all four hosts in V7.C5.)
 */
export function injectRootBaselines(platform?: PlacementPlatform, cwd: string = process.cwd(), say: Say = console.log): void {
  // `cwd` is a parameter rather than a read of `process.cwd()` so this can be exercised
  // against a temp directory without `process.chdir`, which is process-global and leaks
  // into every other test sharing the worker (it did: it changed which persona another
  // suite loaded).
  const claudeMdPath = resolve(cwd, "CLAUDE.md");
  const agentsMdPath = resolve(cwd, "AGENTS.md");
  // An explicitly requested host gets its baseline, existing or not.
  if (platform === "codex" && !existsSync(agentsMdPath)) {
    writeFileSync(agentsMdPath, injectBaselineIntoAgents(""), "utf-8");
    say(chalk.green("✓"), chalk.bold("AGENTS.md"), chalk.dim("(created), @PERSONA.md reference injected"));
    injectSecondaryBaselines(cwd, say);
    return;
  }
  if (platform === "claude-code" && !existsSync(claudeMdPath)) {
    writeFileSync(claudeMdPath, injectBaselineIntoClaude(""), "utf-8");
    say(chalk.green("✓"), chalk.bold("CLAUDE.md"), chalk.dim("(created), @PERSONA.md reference injected"));
    injectSecondaryBaselines(cwd, say);
    return;
  }

  const claudeExists = existsSync(claudeMdPath);
  const agentsExists = existsSync(agentsMdPath);

  if (!claudeExists && !agentsExists) {
    writeFileSync(claudeMdPath, injectBaselineIntoClaude(""), "utf-8");
    say(chalk.green("✓"), chalk.bold("CLAUDE.md"), chalk.dim("(created), @PERSONA.md reference injected"));
    injectSecondaryBaselines(cwd, say);
    return;
  }

  if (claudeExists) {
    const existing = readFileSync(claudeMdPath, "utf-8");
    writeFileSync(claudeMdPath, injectBaselineIntoClaude(existing), "utf-8");
    const action = existing.includes("PERSONA:BASELINE") ? "already up to date" : "updated";
    say(chalk.green("✓"), chalk.bold("CLAUDE.md"), chalk.dim(`(${action}), @PERSONA.md reference injected`));
  }

  if (agentsExists) {
    const existing = readFileSync(agentsMdPath, "utf-8");
    writeFileSync(agentsMdPath, injectBaselineIntoAgents(existing), "utf-8");
    const action = existing.includes("PERSONA:BASELINE") || existing.includes("PERSONA:CODEX") ? "already up to date" : "updated";
    say(chalk.green("✓"), chalk.bold("AGENTS.md"), chalk.dim(`(${action}), @PERSONA.md reference injected`));
  }
  injectSecondaryBaselines(cwd, say);
}

/**
 * V4.3 (V6.9): the target-matrix audit's verdict, in code. Most agent hosts now
 * read AGENTS.md (Codex, Cursor, Zed, Amp, ...) or CLAUDE.md, and SOUL.md hosts
 * have their own targets; the two REAL ecosystems that read a different root
 * context file are Gemini CLI (GEMINI.md) and GitHub Copilot in VS Code
 * (.github/copilot-instructions.md). We refresh the baseline there when the
 * file EXISTS, and never create it (no litter for hosts the project does not
 * use). Full matrix: docs/architecture/target-matrix.md.
 */
function injectSecondaryBaselines(cwd: string = process.cwd(), say: Say = console.log): void {
  const hosts: Array<{ label: string; path: string }> = [
    { label: "GEMINI.md", path: resolve(cwd, "GEMINI.md") },
    { label: ".github/copilot-instructions.md", path: resolve(cwd, ".github", "copilot-instructions.md") },
  ];
  for (const h of hosts) {
    if (!existsSync(h.path)) continue;
    const existing = readFileSync(h.path, "utf-8");
    writeFileSync(h.path, injectBaselineIntoAgents(existing), "utf-8");
    const action = existing.includes("PERSONA:BASELINE") ? "already up to date" : "updated";
    say(chalk.green("✓"), chalk.bold(h.label), chalk.dim(`(${action}), @PERSONA.md reference injected`));
  }
}

export interface RunCompileOptions {
  slug?: string;
  root?: boolean;
  provider?: ProviderName;
  fromFile?: string;
  out?: string;
  stdout?: boolean;
  platform?: PlacementPlatform;
  /** Skip (no-op) unless the persona's compiled doc is marked stale by a self-edit. */
  ifPending?: boolean;
  /** Why this document is written, for its history; otherwise the stale mark's reason, or "compile". */
  cause?: string;
  /** Print nothing: the in-session recompile runs behind a screen it must not write over. */
  quiet?: boolean;
  /** The persona's personaxis.md, when the caller already has it (the in-session recompile). */
  sourcePath?: string;
}

type Say = (...parts: unknown[]) => void;

/** The model's document still failed the faithfulness check after its repairs; nothing was written. */
export class CompileRejectedError extends Error {
  constructor(
    public readonly findings: string[],
    /** Where the last rejected document was kept, to read what the model wrote. */
    public readonly kept?: string,
  ) {
    super(
      `The model's PERSONA.md failed the faithfulness check ${REPAIRS + 1} times, so nothing was written:\n  - ${findings.slice(0, 8).join("\n  - ")}` +
        (kept ? `\nThe last document it wrote is in ${kept}.` : "") +
        `\nRun \`personaxis compile\` again, or with a stronger model.`,
    );
    this.name = "CompileRejectedError";
  }
}

/** How many times a rejected document goes back to the model with its findings before compile stops. */
const REPAIRS = 2;

/**
 * A model writes the compiled document from the spec, held to the reference the code assembles.
 *
 * Until 2026-10-07 the model only polished the assembly, and any failure (no model, an error, a rejected
 * polish) wrote the assembly itself, which is a template. Now the document is the model's or there is
 * none: a rejected document goes back with the exact findings (`checkFaithfulness`), twice, and then
 * compile stops with `CompileRejectedError`. Without a model it refuses with `ModelRequiredError`; the
 * `agent` provider hands each prompt to the coding agent (`ProviderRequiresAgentError`, handled by the
 * caller). `--from-file` takes one document as the model's answer and gates it the same way.
 */
async function writeDocument(
  reference: string,
  personaxisMd: string,
  target: CompileTargetInfo,
  opts: RunCompileOptions,
  overlaid: boolean,
): Promise<{ content: string; via: string; source: ProviderRunResult["source"] | "manual"; model: string; attempts: number }> {
  const provider = resolveProvider(opts.provider, { personaPath: personaxisMd });
  // `agent` is also what resolves when no model is configured; it writes only when asked for by name.
  if (provider.source === "cli-agent" && !opts.provider && !opts.fromFile) throw new ModelRequiredError("Compiling PERSONA.md");

  const prompt = buildWritePrompt({ reference, personaxisMd: readFileSync(personaxisMd, "utf-8"), target, overlaid });
  const unfence = (text: string): string => {
    const t = text.trim();
    const fence = t.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n```$/);
    return fence ? fence[1]!.trim() : t;
  };
  const describe = (f: { kind: string; section: string; text: string }): string =>
    // "As a bullet": the check reads only "- " lines in a protected section, and command-a kept a dropped
    // claim as prose three times when the finding did not say so (2026-10-07).
    f.kind === "dropped" ? `dropped from "${f.section}": ${f.text} (it must be a "- " bullet under that heading; prose there is not read)` : f.section === "(sections)" ? `a heading the reference does not have: "## ${f.text}"` : `added to "${f.section}", not in the reference: ${f.text}`;

  if (opts.fromFile) {
    const content = unfence(readFileSync(resolve(opts.fromFile), "utf-8"));
    const report = checkFaithfulness(reference, content);
    if (!report.ok) throw new CompileRejectedError(report.findings.map(describe));
    return { content, via: "--from-file", source: "manual", model: "manual", attempts: 1 };
  }

  let ask = prompt;
  for (let attempt = 1; ; attempt += 1) {
    const result = await provider.run(ask);
    const content = unfence(result.text);
    const report = checkFaithfulness(reference, content);
    if (report.ok) return { content, via: `written by ${result.source}`, source: result.source, model: result.model, attempts: attempt };
    const findings = report.findings.map(describe);
    if (attempt > REPAIRS) {
      // Kept beside the agent's prompts, never where a host would load it as the persona.
      const kept = join(".personaxis", ".tmp", "rejected-PERSONA.md");
      mkdirSync(dirname(resolve(kept)), { recursive: true });
      writeFileSync(resolve(kept), content + "\n", "utf-8");
      throw new CompileRejectedError(findings, kept);
    }
    if (!opts.quiet) console.log(chalk.yellow("!"), `the document failed the faithfulness check (${findings.length} finding(s)); asking the model to fix them`);
    // The previous document goes back with its findings, so the model fixes those and keeps the rest: asked
    // to write again from the prompt alone, command-a repeated the same six findings three times (2026-10-07).
    ask = `${prompt}\n\nYour previous document:\n\n${content}\n\nIt failed the check. Return it with exactly these fixed, everything else unchanged:\n- ${findings.join("\n- ")}`;
  }
}

/**
 * The v0.7.0 forward direction: `.personaxis/[personas/<slug>/]personaxis.md`
 * (quantitative spec) -> `PERSONA.md` / `<slug>.md` (compiled, qualitative
 * document) via the configured provider. Exported so `migrate 0.6-to-0.7`
 * (B.9) and `push` (B.8) can invoke it directly.
 */
/**
 * What a compile actually did. Returned because callers were guessing: until 2026-10-07 `create`
 * read "runCompile did not throw" as "a model polished it", and printed that over a template the
 * faithfulness gate had rejected. A rejection is now an error (`CompileRejectedError`), and this
 * says how the document that was written came to be.
 */
export interface CompileOutcome {
  /** True when a document was written; false only for `--if-pending` with nothing stale. */
  written: boolean;
  /** How the document was produced, e.g. "written by cli-local". */
  via: string;
  /** How many answers the model needed: 1 when its first document passed the check. */
  attempts: number;
  /** Model that answered, or "none". */
  model: string;
  /** Where the compiled document was written. */
  outPath: string;
}

export async function runCompile(opts: RunCompileOptions): Promise<CompileOutcome> {
  const say: Say = opts.quiet ? () => undefined : console.log;
  // A path given directly decides root or sub-persona by where it lives; otherwise the slug does.
  const isSubagent = opts.sourcePath ? isSubagentPath(opts.sourcePath) : !!opts.slug && !opts.root;
  const slug = !isSubagent ? undefined : opts.sourcePath ? slugAddressFromPath(opts.sourcePath) : (opts.slug as string);
  // Thrown, never process.exit: the in-session recompile runs inside a live session.
  const sourcePath = opts.sourcePath ?? resolvePersonaSourcePath(slug);

  if (opts.ifPending && !readRecompilePending(sourcePath).pending) {
    // Nothing stale: a cheap no-op. Reported as not written because no document was
    // produced, so no caller can mistake this for a model having rewritten anything.
    return { written: false, via: "up to date (no recompile needed)", attempts: 0, model: "none", outPath: compiledPathFor(sourcePath) };
  }

  const baseDir = dirname(sourcePath);
  const raw = readFileSync(sourcePath, "utf-8");

  const loaded = loadPersonaFile(sourcePath);
  const validation = validatePersona(loaded.data);
  if (!validation.valid) throw new Error(`${relative(process.cwd(), sourcePath)} is invalid (${validation.status}). Run \`personaxis validate\` for details.`);

  const stateJson = readSibling(baseDir, "state.json");

  // Canonical compiled-document location (single owner: compiledPathFor in load.ts):
  //   root persona  -> <repo>/PERSONA.md           (one level ABOVE .personaxis/)
  //   root in HOME  -> ~/.personaxis/PERSONA.md    (the home dir is not a project root)
  //   sub-persona   -> .personaxis/personas/<slug>/PERSONA.md  (INSIDE its own folder)
  // This mirrors the resource layout (a sub's files live in its folder) and lets the
  // structure recurse (a sub can itself have .personaxis/personas/<sub2>/).
  const canonicalOutPath = compiledPathFor(sourcePath);
  const canonicalRel = relative(process.cwd(), canonicalOutPath).replace(/\\/g, "/");

  const target: CompileTargetInfo = isSubagent
    ? { label: `sub-persona "${slug}" (.personaxis/personas/${slug}/PERSONA.md)`, outputPath: canonicalRel, isSubagent: true, slug }
    : { label: `root persona (${canonicalRel || "PERSONA.md"})`, outputPath: canonicalRel, isSubagent: false };

  // Fold APPLIED governed self-edits so a recompile reflects what the persona evolved into.
  const appliedOverlay = activeOverlay(sourcePath);

  // The reference: what the code assembles from the spec, the ground truth the model's document is
  // checked against. It is never written as the compiled document.
  // E92: the input, and below the dressing, come from `compiled-document.ts`, which the live
  // recompile asks too. Built here by hand, they had drifted: the live path lost the resource
  // manifest, the sub-persona header and the skill list.
  const assembleInput = assembleInputFor(sourcePath, loaded.data as Record<string, unknown>, {
    appliedOverlay,
    // F6.2: current state selects WHICH band's expression prose compiles in
    // (value → band → prose, deterministic). No state.json → envelope means.
    stateValues: parseStateValues(stateJson),
  });
  const reference = assemblePersonaDoc(assembleInput);

  // The model writes the document, gated by the faithfulness check.
  //
  // D6: this is the only part of a compile that holds the persona long enough for anyone to
  // notice, so it is the only part that announces. Stage 1 and the writes around it are
  // milliseconds, and a presence marker nobody can read in time is noise on disk. Nested
  // under `watch`, this shows "compiling" and restores "watching for spec edits" by itself.
  const presence = holdPresence(sourcePath, { host: "compile", activity: "compiling PERSONA.md" });
  let stage2;
  try {
    stage2 = await writeDocument(reference, sourcePath, target, opts, Object.keys(appliedOverlay ?? {}).length > 0);
  } finally {
    presence.release();
  }
  const result = { source: stage2.source, via: stage2.via, model: stage2.model };
  const compiledText = stage2.content;

  const outPath = resolve(opts.out ?? canonicalOutPath);

  // Subagent placement needs a name/description frontmatter; prepend it (the assembler emits body only).
  const withFrontmatter = dressCompiledDocument(compiledText, sourcePath, loaded.data as Record<string, unknown>);

  if (opts.stdout) {
    process.stdout.write(withFrontmatter + "\n");
    return { written: true, via: stage2.via, attempts: stage2.attempts, model: stage2.model, outPath: "(stdout)" };
  }

  let finalContent = withFrontmatter;
  // The canonical persona.md is the markdown representation; skills materialize in the
  // claude-code convention by default. An explicit --platform additionally EXPORTS a
  // host placement (.claude/agents/<slug>.md or .codex/agents/<slug>.toml) below.
  // Skills materialize in the claude-code/codex convention; SOUL.md hosts (openclaw/Hermes) reuse
  // the claude-code skill layout as the default discovery dir.
  const skillsPlatform: "claude-code" | "codex" = opts.platform === "codex" ? "codex" : "claude-code";

  // D.2/D.3/D.3b: resolve `extensions.skills`, materialize local skills to
  // this platform's discovery directory, write skills-manifest.json, and
  // (for subagents) apply preload/access-control to the compiled document.
  const declaredSkills = resolveDeclaredSkills(loaded.data, baseDir);
  const hasSkillsDir = existsSync(join(baseDir, "skills"));
  let materializedSkills: ReturnType<typeof materializeLocalSkills> = [];

  if (declaredSkills.length || hasSkillsDir) {
    materializedSkills = materializeLocalSkills(declaredSkills, baseDir, skillsPlatform);
    writeSkillsManifest(declaredSkills, baseDir);

    for (const skill of declaredSkills) {
      if (skill.kind === "local") {
        if (skill.missing) {
          say(chalk.yellow("!"), `${skill.name}: skills/${skill.name}/SKILL.md not found (declared in extensions.skills)`);
        } else {
          const materialized = materializedSkills.find((m) => m.name === skill.name);
          const dest = materialized ? `${materialized.destDir.replace(/\\/g, "/")}/` : "";
          say(chalk.green("✓"), skill.name, chalk.dim("→"), dest);
        }
      } else {
        say(chalk.dim(`  ${skill.name}: reference-only (${skill.ref}) - see skills-manifest.json`));
      }
    }
  }

  if (isSubagent) {
    finalContent = dressCompiledDocument(compiledText, sourcePath, loaded.data as Record<string, unknown>, {
      platform: skillsPlatform,
      declared: declaredSkills,
      materialized: materializedSkills,
    });
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, finalContent.trimEnd() + "\n", "utf-8");
  // Every version goes into the persona's record with why it was written and from which definition: a
  // model wrote it, so the definition alone no longer says what an agent read on a given day.
  const pending = readRecompilePending(sourcePath);
  const cause = opts.cause ?? (pending.pending && pending.reason ? pending.reason : "compile");
  if (!opts.out) {
    const handle = loadPersona(sourcePath);
    ensureState(handle);
    await recordCompiled(sourcePath, handle.statePath, { document: finalContent.trimEnd() + "\n", specText: raw, cause, model: result.model });
  }
  clearRecompilePending(sourcePath); // the compiled doc now reflects the spec

  say(chalk.green("✓"), chalk.bold(relative(process.cwd(), sourcePath).replace(/\\/g, "/")), chalk.dim("→"), relative(process.cwd(), outPath).replace(/\\/g, "/"));
  say(chalk.dim(`  via ${result.via} (${result.model})`));

  // F3.2, emit the derived `.dist/` consumer slices beside the spec: a HOT slice
  // (opener + voice + anchors + hard limits, for the always-load hot path) and the
  // COLD full document. Deterministic + ephemeral (rebuilt every compile). Skipped
  // for --out / --stdout (custom sinks) and for subagents (root-identity optimization).
  if (!opts.out && !isSubagent) {
    const { hot, cold } = distSlices(finalContent);
    const distDir = join(baseDir, ".dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, DIST_HOT_FILE), hot, "utf-8");
    writeFileSync(join(distDir, DIST_COLD_FILE), cold, "utf-8");
    say(chalk.dim(`  .dist/ slices: ${DIST_HOT_FILE} (${hot.length}B hot) · ${DIST_COLD_FILE} (${cold.length}B cold)`));
  }

  // Optional host export: place the compiled document into the host's convention so it can adopt the
  // persona. Given when --platform is set (and we're not overriding the output path). Works for the
  // root persona too, openclaw/Hermes read SOUL.md at the workspace/profile root, not PERSONA.md.
  if (opts.platform && !opts.out) {
    const placement = placeCompiledDocument(finalContent, target, opts.platform as PlacementPlatform);
    const placedPath = resolve(placement.path);
    // Skip a redundant rewrite when the placement IS the canonical doc (claude-code/codex root).
    if (placedPath !== resolve(outPath)) {
      mkdirSync(dirname(placedPath), { recursive: true });
      writeFileSync(placedPath, placement.content.trimEnd() + "\n", "utf-8");
      say(chalk.green("✓"), chalk.dim("host export →"), relative(process.cwd(), placedPath).replace(/\\/g, "/"));
    }
  }

  // Root baseline injection (@PERSONA.md into CLAUDE.md/AGENTS.md) only makes sense for the hosts that
  // read those files. openclaw/Hermes auto-load SOUL.md, so skip it for them. Also skipped for a
  // HOME-root persona: no host reads a loose ~/CLAUDE.md or ~/AGENTS.md, it would be litter.
  const homeRoot = !isSubagent && canonicalOutPath.replace(/\\/g, "/").includes("/.personaxis/");
  if (!isSubagent && !homeRoot && !isSoulPlatform(opts.platform as PlacementPlatform | undefined)) {
    injectRootBaselines(opts.platform as PlacementPlatform | undefined, process.cwd(), say);
  }

  saveManifest(baseDir, {
    spec_version: loaded.data.spec_version ?? "0.10.0",
    compiledPath: relative(process.cwd(), outPath).replace(/\\/g, "/"),
    personaxisMdHash: hashContent(raw),
    compiledMdHash: hashContent(finalContent),
    lastOp: "compile",
    model: result.model,
    source: result.source,
    timestamp: new Date().toISOString(),
  });

  return { written: true, via: stage2.via, attempts: stage2.attempts, model: stage2.model, outPath };
}

export const compileCommand = new Command("compile")
  .description("Compile personaxis.md -> canonical PERSONA.md (root) / .personaxis/personas/<slug>/persona.md (sub)")
  .argument("[slug]", "Subagent slug to compile (defaults to the root persona)")
  .option("--root", "Compile the root persona (.personaxis/personaxis.md -> repo-root PERSONA.md). Default when [slug] is omitted.")
  .option("--provider <name>", "Override the configured provider (local | byok | agent)")
  .option("--from-file <path>", "Use this file's contents as the compiled output instead of calling the provider")
  .option("-o, --out <path>", "Output file path (overrides the canonical default)")
  .option("--stdout", "Print to stdout instead of writing a file")
  .option("--platform <platform>", `Also EXPORT a host placement for a sub-persona (.claude/agents or .codex): ${PLACEMENT_PLATFORMS.join(" | ")}`)
  .option("--if-pending", "No-op unless a self-edit marked the compiled doc stale (.recompile-pending.json)")
  .option("--history", "List every version of the compiled document: when, why, from which definition, by which model")
  .action(async (slug: string | undefined, opts: { root?: boolean; provider?: string; fromFile?: string; out?: string; stdout?: boolean; platform?: string; ifPending?: boolean; history?: boolean }) => {
    if (opts.history) {
      const sourcePath = resolvePersonaSourcePath(slug && !opts.root ? slug : undefined);
      const versions = compiledHistory(sourcePath);
      if (!versions.length) return void console.log(chalk.dim("  No compiled version recorded yet."));
      for (const v of versions) {
        const kept = v.path ? relative(process.cwd(), v.path).replace(/\\/g, "/") : chalk.dim("(text not kept)");
        console.log(`  ${v.at.slice(0, 19).replace("T", " ")}  ${v.hash.slice(0, 12)}  ${v.cause ?? "compile"}${v.model ? chalk.dim(` · ${v.model}`) : ""}`);
        console.log(chalk.dim(`    from definition ${v.spec?.slice(0, 12) ?? "?"} · ${kept}`));
      }
      return;
    }
    if (opts.platform && !(PLACEMENT_PLATFORMS as readonly string[]).includes(opts.platform)) {
      console.error(chalk.red("Unknown platform:"), opts.platform);
      console.error(chalk.dim("Valid platforms:"), PLACEMENT_PLATFORMS.join(", "));
      process.exit(1);
    }

    try {
      await runCompile({
        slug,
        root: opts.root,
        provider: opts.provider as ProviderName | undefined,
        fromFile: opts.fromFile,
        out: opts.out,
        stdout: opts.stdout,
        platform: opts.platform as PlacementPlatform | undefined,
        ifPending: opts.ifPending,
      });
    } catch (err) {
      // The prompt is waiting for the coding agent: say where, exit 0, as `create` does.
      if (err instanceof ProviderRequiresAgentError) {
        console.log(err.message.replace("Then re-run this command with --from-file " + err.resultFile + " to apply the result.", "Then re-run this same command: it reads the answer and continues."));
        return;
      }
      console.error(chalk.red("Error:"), (err as Error).message);
      // Not process.exit: a failure right after a model call aborts the process on Windows.
      process.exitCode = 1;
    }
  });
