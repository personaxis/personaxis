import { Command } from "commander";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname, relative, join } from "path";
import chalk from "chalk";
import { loadPersonaFile, resolvePersonaSourcePath } from "../load.js";
import { validatePersona } from "../schema.js";
import { injectBaselineIntoClaude } from "../targets/claude-code.js";
import { injectBaselineIntoAgents } from "../targets/codex.js";
import { buildResourceManifest } from "../resource-manifest.js";
import { activeOverlay } from "@personaxis/core";
import { buildCompilePrompt, type CompileTargetInfo } from "../compile-instructions.js";
import { resolveProvider, type ProviderName } from "../providers/index.js";
import { runProviderOrExit } from "../provider-run.js";
import { hashContent, saveManifest } from "../manifest.js";
import { placeCompiledDocument, PLACEMENT_PLATFORMS, type PlacementPlatform } from "../targets/placement.js";
import { resolveDeclaredSkills, materializeLocalSkills, writeSkillsManifest, applySkillsToSubagent } from "../targets/skills.js";

function readSibling(baseDir: string, name: string): string | undefined {
  const p = join(baseDir, name);
  return existsSync(p) ? readFileSync(p, "utf-8") : undefined;
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
  const prompt = buildCompilePrompt({ personaxisMd: raw, policyYaml, stateJson, resourceManifest, target, appliedOverlay });

  const provider = resolveProvider(opts.provider);
  const result = await runProviderOrExit(provider, prompt, opts.fromFile);
  let compiledText = result.text.trim();
  // Some providers wrap the whole document in a ```fence``` despite instructions — strip it.
  const fence = compiledText.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n```$/);
  if (fence) compiledText = fence[1].trim();

  const outPath = resolve(opts.out ?? canonicalOutPath);

  if (opts.stdout) {
    process.stdout.write(compiledText + "\n");
    return;
  }

  let finalContent = compiledText;
  // The canonical persona.md is the markdown representation; skills materialize in the
  // claude-code convention by default. An explicit --platform additionally EXPORTS a
  // host placement (.claude/agents/<slug>.md or .codex/agents/<slug>.toml) below.
  const skillsPlatform = (opts.platform as "claude-code" | "codex" | undefined) ?? "claude-code";

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

  console.log(chalk.green("✓"), chalk.bold(relative(process.cwd(), sourcePath).replace(/\\/g, "/")), chalk.dim("→"), relative(process.cwd(), outPath).replace(/\\/g, "/"));
  console.log(chalk.dim(`  via ${result.source} (${result.model})`));

  // Optional host export: place the compiled sub-persona into the host agent's
  // subagent convention so Claude Code / Codex can route to it. Only when --platform
  // is given and we're not overriding the output path.
  if (isSubagent && opts.platform && !opts.out) {
    const placement = placeCompiledDocument(finalContent, { ...target, outputPath: `.claude/agents/${slug}.md` }, opts.platform as PlacementPlatform);
    const placedPath = resolve(placement.path);
    mkdirSync(dirname(placedPath), { recursive: true });
    writeFileSync(placedPath, placement.content.trimEnd() + "\n", "utf-8");
    console.log(chalk.green("✓"), chalk.dim("host export →"), relative(process.cwd(), placedPath).replace(/\\/g, "/"));
  }

  if (!isSubagent) {
    injectRootBaselines();
  }

  saveManifest(baseDir, {
    spec_version: loaded.data.spec_version ?? "0.7.0",
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
  .action(async (slug: string | undefined, opts: { root?: boolean; provider?: string; fromFile?: string; out?: string; stdout?: boolean; platform?: string }) => {
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
    });
  });
