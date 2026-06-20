import { Command } from "commander";
import { existsSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { resolve, sep, dirname } from "path";
import chalk from "chalk";
import { validatePersona, exitCodeFor } from "../schema.js";
import { compileClaudeCodeAgent, injectBaselineIntoClaude } from "../targets/claude-code.js";
import { compileCodexAgent } from "../targets/codex.js";
import { loadPersonaFile } from "../load.js";
import { buildMarketingGuru } from "./init.js";

const TEMPLATES: Record<string, { display: string }> = {
  "marketing-guru": { display: "Marketing Guru — full-stack marketing professional" },
};

const TARGETS = ["claude-code", "codex"] as const;
const ARCHIVED_TARGETS = ["cursor", "soul-md"] as const;
type Target = (typeof TARGETS)[number];

function compileToTarget(
  loaded: ReturnType<typeof loadPersonaFile>,
  target: Target,
  folderSlug: string
): void {
  const displayName = loaded.data.metadata?.display_name ?? loaded.data.metadata?.name ?? folderSlug;

  if (target === "claude-code") {
    const output = compileClaudeCodeAgent(loaded.data, folderSlug);
    const dest = resolve(`.claude${sep}agents${sep}${folderSlug}.md`);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, output, "utf-8");
    console.log(chalk.green("✓"), "Compiled", chalk.dim("→"), `.claude/agents/${folderSlug}.md`);
    console.log(chalk.dim(`  Claude Code subagent for ${displayName}. Invoke with /agents.`));

    // CLAUDE.md baseline injection
    const claudeMdPath = resolve("CLAUDE.md");
    const existingClaude = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, "utf-8") : "";
    writeFileSync(claudeMdPath, injectBaselineIntoClaude(existingClaude), "utf-8");
    const action = existingClaude.includes("PERSONA:BASELINE") ? "already up to date" : "updated";
    console.log(chalk.green("✓"), chalk.bold("CLAUDE.md"), chalk.dim(`(${action})`));
  } else {
    const output = compileCodexAgent(loaded.data, folderSlug);
    const dest = resolve(`.codex${sep}agents${sep}${folderSlug}.toml`);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, output, "utf-8");
    console.log(chalk.green("✓"), "Compiled", chalk.dim("→"), `.codex/agents/${folderSlug}.toml`);
  }
}

export const useCommand = new Command("use")
  .description("Create and optionally compile a persona template in one step (spec v0.7.0)")
  .argument("<template>", `Template name. Available: ${Object.keys(TEMPLATES).join(", ")}`)
  .option("-n, --name <name>", "Agent display name (defaults to template default)")
  .option("-t, --target <target>", `Also compile to this target: ${TARGETS.join(" | ")}`)
  .option("-f, --force", "Overwrite existing files")
  .action((template: string, opts: { name?: string; target?: string; force?: boolean }) => {
    if (!TEMPLATES[template]) {
      console.error(chalk.red("Unknown template:"), template);
      console.error(chalk.dim("Available:"), Object.keys(TEMPLATES).join(", "));
      process.exit(1);
    }

    if (opts.target && !(TARGETS as readonly string[]).includes(opts.target)) {
      if ((ARCHIVED_TARGETS as readonly string[]).includes(opts.target)) {
        console.error(chalk.yellow("Archived target:"), opts.target);
        console.error(chalk.dim("Cursor and SOUL.md exports are archived. Use:"), TARGETS.join(", "));
      } else {
        console.error(chalk.red("Unknown target:"), opts.target);
        console.error(chalk.dim("Valid targets:"), TARGETS.join(", "));
      }
      process.exit(1);
    }

    const displayName = opts.name?.trim() || "Maven";
    const nameSlug = opts.name?.trim()
      ? opts.name.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")
      : "";
    const folderSlug = nameSlug ? `${template}_${nameSlug}` : template;
    const metaSlug = folderSlug.replace(/-/g, "_");

    const dir = resolve(`.personaxis${sep}personas${sep}${folderSlug}`);
    const outPath = resolve(dir, "personaxis.md");

    if (existsSync(outPath) && !opts.force) {
      console.error(chalk.yellow("Already exists:"), `.personaxis/personas/${folderSlug}/personaxis.md`);
      console.error(chalk.dim("Use --force to overwrite."));
      process.exit(1);
    }

    let content: string;
    if (template === "marketing-guru") {
      content = buildMarketingGuru(displayName, metaSlug);
    } else {
      console.error(chalk.red("Template build not available for:"), template);
      process.exit(1);
    }

    mkdirSync(dir, { recursive: true });
    writeFileSync(outPath, content, "utf-8");
    console.log(chalk.green("✓"), chalk.bold(displayName), chalk.dim(`→ .personaxis/personas/${folderSlug}/personaxis.md`));

    if (opts.target) {
      let loaded;
      try {
        loaded = loadPersonaFile(outPath);
      } catch (err) {
        console.error(chalk.red("Error loading persona:"), (err as Error).message);
        process.exit(1);
      }

      const validation = validatePersona(loaded.data);
      if (!validation.valid) {
        console.error(chalk.red("✗"), `Generated persona failed validation: ${validation.status}`);
        for (const e of validation.errors.slice(0, 5)) console.error("  -", e.field, e.message);
        process.exit(exitCodeFor(validation.status));
      }

      compileToTarget(loaded, opts.target as Target, folderSlug);
    } else {
      console.log(chalk.dim("  To compile:"));
      console.log(chalk.cyan(`  personaxis compile ${folderSlug} --platform claude-code`));
      console.log(chalk.cyan(`  personaxis compile ${folderSlug} --platform codex`));
    }
  });
