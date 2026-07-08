import { Command } from "commander";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname, relative, join } from "path";
import chalk from "chalk";
import { loadPersonaFile, resolvePersonaSourcePath } from "../load.js";
import { validatePersona } from "../schema.js";
import { injectBaselineIntoClaude } from "../targets/claude-code.js";
import { injectBaselineIntoAgents } from "../targets/codex.js";
import { buildResourceManifest } from "../resource-manifest.js";
import {
  activeOverlay,
  readRecompilePending,
  clearRecompilePending,
  assemblePersonaDoc,
  checkFaithfulness,
  summarizeFaithfulness,
  distSlices,
  DIST_HOT_FILE,
  DIST_COLD_FILE,
  type AssembleInput,
} from "@personaxis/core";
import { buildPolishPrompt, type CompileTargetInfo } from "../compile-instructions.js";
import { ProviderRequiresAgentError, type ProviderRunResult } from "../providers/types.js";
import { resolveProvider, type ProviderName } from "../providers/index.js";
import { runProviderOrExit } from "../provider-run.js";
import { hashContent, saveManifest } from "../manifest.js";
import { placeCompiledDocument, isSoulPlatform, PLACEMENT_PLATFORMS, type PlacementPlatform } from "../targets/placement.js";
import { resolveDeclaredSkills, materializeLocalSkills, writeSkillsManifest, applySkillsToSubagent } from "../targets/skills.js";

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

/** The name the compiled document addresses: short_name (chat handle) → display_name → metadata.name. */
function personaName(data: Record<string, unknown>): string {
  const identity = (data.identity ?? {}) as { short_name?: string; display_name?: string; canonical_id?: string };
  const meta = (data.metadata ?? {}) as { name?: string };
  return identity.short_name ?? identity.display_name ?? meta.name ?? identity.canonical_id ?? "persona";
}

/**
 * Subagent placement (.claude/agents/<slug>.md, …) expects a `name`/`description`
 * frontmatter the host uses to decide when to invoke the subagent. The deterministic
 * assembler emits the body only, so we prepend it here from the spec.
 */
function subagentFrontmatter(slug: string, data: Record<string, unknown>): string {
  const meta = (data.metadata ?? {}) as { description?: string };
  const identity = (data.identity ?? {}) as { system_identity?: { purpose?: string } };
  const description =
    (meta.description ?? identity.system_identity?.purpose ?? `The ${slug} persona.`)
      .replace(/\s+/g, " ")
      .trim();
  return `---\nname: ${slug}\ndescription: ${JSON.stringify(description)}\n---\n\n`;
}

function injectRootBaselines(): void {
  const claudeMdPath = resolve("CLAUDE.md");
  const agentsMdPath = resolve("AGENTS.md");
  const claudeExists = existsSync(claudeMdPath);
  const agentsExists = existsSync(agentsMdPath);

  if (!claudeExists && !agentsExists) {
    writeFileSync(claudeMdPath, injectBaselineIntoClaude(""), "utf-8");
    console.log(chalk.green("✓"), chalk.bold("CLAUDE.md"), chalk.dim("(created) — @PERSONA.md reference injected"));
    return;
  }

  if (claudeExists) {
    const existing = readFileSync(claudeMdPath, "utf-8");
    writeFileSync(claudeMdPath, injectBaselineIntoClaude(existing), "utf-8");
    const action = existing.includes("PERSONA:BASELINE") ? "already up to date" : "updated";
    console.log(chalk.green("✓"), chalk.bold("CLAUDE.md"), chalk.dim(`(${action}) — @PERSONA.md reference injected`));
  }

  if (agentsExists) {
    const existing = readFileSync(agentsMdPath, "utf-8");
    writeFileSync(agentsMdPath, injectBaselineIntoAgents(existing), "utf-8");
    const action = existing.includes("PERSONA:BASELINE") || existing.includes("PERSONA:CODEX") ? "already up to date" : "updated";
    console.log(chalk.green("✓"), chalk.bold("AGENTS.md"), chalk.dim(`(${action}) — @PERSONA.md reference injected`));
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
  /** F3.1: skip the LLM polish stage — write the deterministic assembled document. */
  noPolish?: boolean;
}

/**
 * F3.1 stage 2 — run the LLM polish over the assembled document and gate it
 * with the deterministic faithfulness check. Returns the document to write and
 * how it was produced. On any failure (no real provider, provider error, or a
 * faithfulness violation) it falls back to the assembled document — compile
 * ALWAYS produces a correct doc, provider or not.
 */
async function polishOrFallback(
  assembled: string,
  personaxisMd: string,
  target: CompileTargetInfo,
  opts: RunCompileOptions,
): Promise<{ content: string; polished: boolean; via: string; source: ProviderRunResult["source"] | "manual"; model: string }> {
  const provider = resolveProvider(opts.provider);
  // Smart-default `agent` handoff with no explicit choice and no --from-file:
  // there is no model to polish with, so write the deterministic doc directly.
  const agentByDefault = provider.source === "cli-agent" && !opts.provider && !opts.fromFile;
  if (opts.noPolish || agentByDefault) {
    return { content: assembled, polished: false, via: "deterministic assembler", source: provider.source, model: "none" };
  }

  const prompt = buildPolishPrompt({ assembled, personaxisMd, target });
  let result;
  try {
    result = await runProviderOrExit(provider, prompt, opts.fromFile);
  } catch (err) {
    if (err instanceof ProviderRequiresAgentError) throw err; // handled by runProviderOrExit (exits)
    console.log(chalk.yellow("!"), `polish skipped (${(err as Error).message}); wrote the deterministic document.`);
    return { content: assembled, polished: false, via: "deterministic assembler", source: provider.source, model: "none" };
  }

  let polished = result.text.trim();
  const fence = polished.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n```$/);
  if (fence) polished = fence[1].trim();

  const report = checkFaithfulness(assembled, polished);
  if (!report.ok) {
    console.log(chalk.yellow("!"), summarizeFaithfulness(report));
    for (const f of report.findings.slice(0, 6)) {
      console.log(chalk.dim(`    ${f.kind === "dropped" ? "dropped" : "invented"} [${f.section}] ${f.text.slice(0, 80)}`));
    }
    console.log(chalk.dim("  → kept the deterministic assembled document (polish rejected)."));
    return { content: assembled, polished: false, via: "deterministic assembler (polish rejected)", source: result.source, model: result.model };
  }
  return { content: polished, polished: true, via: `${result.source} polish`, source: result.source, model: result.model };
}

/**
 * The v0.7.0 forward direction: `.personaxis/[personas/<slug>/]personaxis.md`
 * (quantitative spec) -> `PERSONA.md` / `<slug>.md` (compiled, qualitative
 * document) via the configured provider. Exported so `migrate 0.6-to-0.7`
 * (B.9) and `push` (B.8) can invoke it directly.
 */
export async function runCompile(opts: RunCompileOptions): Promise<void> {
  const isSubagent = !!opts.slug && !opts.root;
  const slug = isSubagent ? (opts.slug as string) : undefined;

  let sourcePath: string;
  try {
    sourcePath = resolvePersonaSourcePath(slug);
  } catch (err) {
    console.error(chalk.red("Error:"), (err as Error).message);
    process.exit(1);
  }

  if (opts.ifPending && !readRecompilePending(sourcePath).pending) {
    return; // nothing stale — cheap no-op
  }

  const baseDir = dirname(sourcePath);
  const raw = readFileSync(sourcePath, "utf-8");

  let loaded;
  try {
    loaded = loadPersonaFile(sourcePath);
  } catch (err) {
    console.error(chalk.red("Error:"), (err as Error).message);
    process.exit(1);
  }

  const validation = validatePersona(loaded.data);
  if (!validation.valid) {
    console.error(chalk.red("✗"), `${relative(process.cwd(), sourcePath)} is invalid (${validation.status}). Run`, chalk.cyan("personaxis validate"), "for details.");
    process.exit(1);
  }

  const policyYaml = readSibling(baseDir, "policy.yaml");
  const stateJson = readSibling(baseDir, "state.json");
  const resourceManifest = buildResourceManifest(baseDir);

  // Canonical compiled-document location:
  //   root persona  -> <repo>/PERSONA.md           (one level ABOVE .personaxis/)
  //   sub-persona   -> .personaxis/personas/<slug>/persona.md  (INSIDE its own folder)
  // This mirrors the resource layout (a sub's files live in its folder) and lets the
  // structure recurse (a sub can itself have .personaxis/personas/<sub2>/).
  const canonicalOutPath = isSubagent ? join(baseDir, "PERSONA.md") : resolve(baseDir, "..", "PERSONA.md");
  const canonicalRel = relative(process.cwd(), canonicalOutPath).replace(/\\/g, "/");

  const target: CompileTargetInfo = isSubagent
    ? { label: `sub-persona "${slug}" (.personaxis/personas/${slug}/PERSONA.md)`, outputPath: canonicalRel, isSubagent: true, slug }
    : { label: "root persona (repo-root PERSONA.md)", outputPath: canonicalRel, isSubagent: false };

  // Fold APPLIED governed self-edits so a recompile reflects what the persona evolved into.
  const appliedOverlay = activeOverlay(sourcePath);

  // F3.1 — STAGE 1: the deterministic assembler always runs. It is the canonical,
  // hashable artifact and the ground truth the optional polish is checked against.
  const assembleInput: AssembleInput = {
    persona: loaded.data as Record<string, unknown>,
    resourceManifest,
    target: {
      name: personaName(loaded.data),
      isSubagent,
      slug,
      resourceBase: isSubagent ? "./" : "./.personaxis/",
    },
    appliedOverlay: Object.keys(appliedOverlay).length ? appliedOverlay : undefined,
    // F6.2: current state selects WHICH band's expression prose compiles in
    // (value → band → prose, deterministic). No state.json → envelope means.
    stateValues: parseStateValues(stateJson),
  };
  const assembled = assemblePersonaDoc(assembleInput);

  // F3.1 — STAGE 2: optional LLM polish, gated by the faithfulness check.
  const stage2 = await polishOrFallback(assembled, raw, target, opts);
  const result = { source: stage2.source, via: stage2.via, model: stage2.model };
  const compiledText = stage2.content;

  const outPath = resolve(opts.out ?? canonicalOutPath);

  // Subagent placement needs a name/description frontmatter; prepend it (the assembler emits body only).
  const withFrontmatter = isSubagent && slug ? subagentFrontmatter(slug, loaded.data as Record<string, unknown>) + compiledText : compiledText;

  if (opts.stdout) {
    process.stdout.write(withFrontmatter + "\n");
    return;
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
          console.log(chalk.yellow("!"), `${skill.name}: skills/${skill.name}/SKILL.md not found (declared in extensions.skills)`);
        } else {
          const materialized = materializedSkills.find((m) => m.name === skill.name);
          const dest = materialized ? `${materialized.destDir.replace(/\\/g, "/")}/` : "";
          console.log(chalk.green("✓"), skill.name, chalk.dim("→"), dest);
        }
      } else {
        console.log(chalk.dim(`  ${skill.name}: reference-only (${skill.ref}) - see skills-manifest.json`));
      }
    }
  }

  if (isSubagent) {
    finalContent = applySkillsToSubagent(finalContent, skillsPlatform, declaredSkills, materializedSkills);
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, finalContent.trimEnd() + "\n", "utf-8");
  clearRecompilePending(sourcePath); // the compiled doc now reflects the spec

  console.log(chalk.green("✓"), chalk.bold(relative(process.cwd(), sourcePath).replace(/\\/g, "/")), chalk.dim("→"), relative(process.cwd(), outPath).replace(/\\/g, "/"));
  console.log(chalk.dim(`  via ${result.via} (${result.model})`));

  // F3.2 — emit the derived `.dist/` consumer slices beside the spec: a HOT slice
  // (opener + voice + anchors + hard limits, for the always-load hot path) and the
  // COLD full document. Deterministic + ephemeral (rebuilt every compile). Skipped
  // for --out / --stdout (custom sinks) and for subagents (root-identity optimization).
  if (!opts.out && !isSubagent) {
    const { hot, cold } = distSlices(finalContent);
    const distDir = join(baseDir, ".dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, DIST_HOT_FILE), hot, "utf-8");
    writeFileSync(join(distDir, DIST_COLD_FILE), cold, "utf-8");
    console.log(chalk.dim(`  .dist/ slices: ${DIST_HOT_FILE} (${hot.length}B hot) · ${DIST_COLD_FILE} (${cold.length}B cold)`));
  }

  // Optional host export: place the compiled document into the host's convention so it can adopt the
  // persona. Given when --platform is set (and we're not overriding the output path). Works for the
  // root persona too — openclaw/Hermes read SOUL.md at the workspace/profile root, not PERSONA.md.
  if (opts.platform && !opts.out) {
    const placement = placeCompiledDocument(finalContent, target, opts.platform as PlacementPlatform);
    const placedPath = resolve(placement.path);
    // Skip a redundant rewrite when the placement IS the canonical doc (claude-code/codex root).
    if (placedPath !== resolve(outPath)) {
      mkdirSync(dirname(placedPath), { recursive: true });
      writeFileSync(placedPath, placement.content.trimEnd() + "\n", "utf-8");
      console.log(chalk.green("✓"), chalk.dim("host export →"), relative(process.cwd(), placedPath).replace(/\\/g, "/"));
    }
  }

  // Root baseline injection (@PERSONA.md into CLAUDE.md/AGENTS.md) only makes sense for the hosts that
  // read those files. openclaw/Hermes auto-load SOUL.md, so skip it for them.
  if (!isSubagent && !isSoulPlatform(opts.platform as PlacementPlatform | undefined)) {
    injectRootBaselines();
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
}

export const compileCommand = new Command("compile")
  .description("Compile personaxis.md -> canonical PERSONA.md (root) / .personaxis/personas/<slug>/persona.md (sub)")
  .argument("[slug]", "Subagent slug to compile (defaults to the root persona)")
  .option("--root", "Compile the root persona (.personaxis/personaxis.md -> repo-root PERSONA.md). Default when [slug] is omitted.")
  .option("--provider <name>", "Override the configured provider (local | byok | agent | remote)")
  .option("--from-file <path>", "Use this file's contents as the compiled output instead of calling the provider")
  .option("-o, --out <path>", "Output file path (overrides the canonical default)")
  .option("--stdout", "Print to stdout instead of writing a file")
  .option("--platform <platform>", `Also EXPORT a host placement for a sub-persona (.claude/agents or .codex): ${PLACEMENT_PLATFORMS.join(" | ")}`)
  .option("--if-pending", "No-op unless a self-edit marked the compiled doc stale (.recompile-pending.json)")
  .option("--no-polish", "Write the deterministic assembled document; skip the LLM polish stage")
  .action(async (slug: string | undefined, opts: { root?: boolean; provider?: string; fromFile?: string; out?: string; stdout?: boolean; platform?: string; ifPending?: boolean; polish?: boolean }) => {
    if (opts.platform && !(PLACEMENT_PLATFORMS as readonly string[]).includes(opts.platform)) {
      console.error(chalk.red("Unknown platform:"), opts.platform);
      console.error(chalk.dim("Valid platforms:"), PLACEMENT_PLATFORMS.join(", "));
      process.exit(1);
    }

    await runCompile({
      slug,
      root: opts.root,
      provider: opts.provider as ProviderName | undefined,
      fromFile: opts.fromFile,
      out: opts.out,
      stdout: opts.stdout,
      platform: opts.platform as PlacementPlatform | undefined,
      ifPending: opts.ifPending,
      noPolish: opts.polish === false, // commander: --no-polish sets polish=false
    });
  });
