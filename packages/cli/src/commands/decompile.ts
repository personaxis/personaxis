import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve, dirname, relative, join } from "path";
import chalk from "chalk";
import matter from "gray-matter";
import { loadPersonaFile, resolvePersonaSourcePath } from "../load.js";
import { validatePersona, exitCodeFor } from "../schema.js";
import { buildResourceManifest } from "../resource-manifest.js";
import { buildDecompilePrompt, type CompileTargetInfo } from "../compile-instructions.js";
import { resolveProvider, type ProviderName } from "../providers/index.js";
import { runWithRepair } from "../llm-repair.js";
import { hashContent, saveManifest } from "../manifest.js";

function readSibling(baseDir: string, name: string): string | undefined {
  const p = join(baseDir, name);
  return existsSync(p) ? readFileSync(p, "utf-8") : undefined;
}

export interface RunDecompileOptions {
  slug?: string;
  root?: boolean;
  provider?: ProviderName;
  fromFile?: string;
}

/**
 * The v0.7.0 reverse direction: a hand-edited `PERSONA.md` / `<slug>.md`
 * (compiled, qualitative document) -> a proposed
 * `.personaxis/[personas/<slug>/]personaxis.md` (quantitative spec), validated
 * before being written. Exported so `push` (B.8) can invoke it directly.
 */
export async function runDecompile(opts: RunDecompileOptions): Promise<void> {
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
  const currentPersonaxisMd = readFileSync(sourcePath, "utf-8");

  const target: CompileTargetInfo = isSubagent
    ? { label: `Claude Code subagent .claude/agents/${slug}.md`, outputPath: `.claude/agents/${slug}.md`, isSubagent: true, slug }
    : { label: "repo-root PERSONA.md (root mode)", outputPath: "PERSONA.md", isSubagent: false };

  const compiledPath = resolve(target.outputPath);
  if (!existsSync(compiledPath)) {
    console.error(chalk.red("Error:"), `${target.outputPath} not found. Run`, chalk.cyan(isSubagent ? `personaxis compile ${slug}` : "personaxis compile --root"), "first.");
    process.exit(1);
  }

  const editedCompiledMd = readFileSync(compiledPath, "utf-8");
  const policyYaml = readSibling(baseDir, "policy.yaml");
  const stateJson = readSibling(baseDir, "state.json");
  const resourceManifest = buildResourceManifest(baseDir);

  const prompt = buildDecompilePrompt({ currentPersonaxisMd, editedCompiledMd, policyYaml, stateJson, resourceManifest, target });

  const provider = resolveProvider(opts.provider);

  // Fence-strip + frontmatter-parse + five-state validation as the repair
  // critique: the exact failing fields go back to the model (bounded rounds,
  // F6.5), an invalid personaxis.md is NEVER written.
  const normalize = (raw: string): string => {
    let proposed = raw.trim();
    // Some providers wrap the whole document in a ```fence``` despite instructions, strip it,
    // otherwise gray-matter sees the fence as body and the frontmatter (all the spec) is lost.
    const fence = proposed.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n```$/);
    if (fence) proposed = fence[1].trim();
    return proposed + "\n";
  };
  const critique = (raw: string): string | null => {
    let data: unknown;
    try {
      data = matter(normalize(raw)).data;
    } catch (err) {
      return `The document could not be parsed as YAML frontmatter: ${(err as Error).message}`;
    }
    const v = validatePersona(data as Record<string, unknown>);
    if (v.valid) return null;
    return v.errors.map((e) => `- ${e.field ? `${e.field}: ` : ""}${e.message}`).join("\n");
  };

  const outcome = await runWithRepair({
    provider,
    prompt,
    critique,
    fromFile: opts.fromFile,
    onRetry: (round, c) =>
      console.log(chalk.yellow(`! validation failed, repair round ${round}:`) + chalk.dim(` ${c.split("\n")[0]}${c.includes("\n") ? " …" : ""}`)),
  });

  if ("failed" in outcome) {
    const status = (() => {
      try {
        return validatePersona(matter(normalize(outcome.last.text)).data as Record<string, unknown>).status;
      } catch {
        return "FAIL_SCHEMA" as const;
      }
    })();
    console.error(chalk.red("✗"), `Proposed personaxis.md failed validation after ${outcome.critiques.length} round(s). Nothing was written.`);
    console.error(chalk.dim(outcome.critiques[outcome.critiques.length - 1] ?? ""));
    process.exit(exitCodeFor(status));
  }

  const result = outcome;
  const proposedSpecMarkdown = normalize(result.text);
  const data = matter(proposedSpecMarkdown).data;
  const validation = validatePersona(data);
  if (result.rounds > 1) console.log(chalk.dim(`  accepted on repair round ${result.rounds}`));

  writeFileSync(sourcePath, proposedSpecMarkdown, "utf-8");

  console.log(chalk.green("✓"), chalk.bold(relative(process.cwd(), compiledPath).replace(/\\/g, "/")), chalk.dim("→"), relative(process.cwd(), sourcePath).replace(/\\/g, "/"));
  console.log(chalk.dim(`  via ${result.source} (${result.model})`));
  if (validation.warnings.length > 0) {
    for (const w of validation.warnings) {
      const field = w.field ? chalk.cyan(w.field) + ", " : "";
      console.log(`  ${chalk.yellow("!")} ${field}${w.message}`);
    }
  }

  // loadPersonaFile re-reads to confirm the written file still resolves cleanly.
  loadPersonaFile(sourcePath);

  saveManifest(baseDir, {
    spec_version: (data as { spec_version?: string }).spec_version ?? "0.10.0",
    compiledPath: relative(process.cwd(), compiledPath).replace(/\\/g, "/"),
    personaxisMdHash: hashContent(proposedSpecMarkdown),
    compiledMdHash: hashContent(editedCompiledMd),
    lastOp: "decompile",
    model: result.model,
    source: result.source,
    timestamp: new Date().toISOString(),
  });
}

export const decompileCommand = new Command("decompile")
  .description("Propose .personaxis/[personas/<slug>/]personaxis.md updates from a hand-edited PERSONA.md / <slug>.md")
  .argument("[slug]", "Subagent slug to decompile (defaults to the root persona)")
  .option("--root", "Decompile the root persona (PERSONA.md -> .personaxis/personaxis.md). Default when [slug] is omitted.")
  .option("--provider <name>", "Override the configured provider (local | byok | agent | remote)")
  .option("--from-file <path>", "Use this file's contents as the proposed personaxis.md instead of calling the provider")
  .action(async (slug: string | undefined, opts: { root?: boolean; provider?: string; fromFile?: string }) => {
    await runDecompile({
      slug,
      root: opts.root,
      provider: opts.provider as ProviderName | undefined,
      fromFile: opts.fromFile,
    });
  });
