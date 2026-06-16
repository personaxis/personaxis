import { Command } from "commander";
import { existsSync, readdirSync, statSync } from "fs";
import { resolve, join } from "path";
import chalk from "chalk";
import matter from "gray-matter";

const BUILT_IN_TEMPLATES: Array<{ slug: string; display: string }> = [
  { slug: "marketing-guru", display: "Full-stack marketing professional for founders and small teams" },
  // coming soon: software-engineer, code-reviewer, legal-assistant, data-analyst, product-manager
];

export const listCommand = new Command("list")
  .description("List personas installed in this project (.personaxis/personas/)")
  .action(() => {
    const personasDir = resolve(process.cwd(), ".personaxis", "personas");

    if (!existsSync(personasDir)) {
      console.log("");
      console.log(chalk.dim("No personas found in .personaxis/personas/"));
      console.log(chalk.dim("Create one with:"), chalk.cyan("personaxis init --agent"));
      console.log(chalk.dim("Or use a template:"), chalk.cyan("personaxis use marketing-guru"));
      console.log("");
      return;
    }

    const entries = readdirSync(personasDir).filter((name) => {
      return statSync(join(personasDir, name)).isDirectory();
    });

    if (entries.length === 0) {
      console.log("");
      console.log(chalk.dim("No personas found in .personaxis/personas/"));
      console.log(chalk.dim("Create one with:"), chalk.cyan("personaxis init --agent"));
      console.log("");
      return;
    }

    console.log("");
    console.log(chalk.bold("Installed personas"));
    console.log("");

    for (const slug of entries) {
      const personaPath = join(personasDir, slug, "PERSONA.md");
      let name = slug;
      let role = "";

      if (existsSync(personaPath)) {
        try {
          const parsed = matter.read(personaPath);
          const metadata = parsed.data.metadata as Record<string, unknown> | undefined;
          const identity = parsed.data.identity as Record<string, unknown> | undefined;
          const roleIdentity = identity?.role_identity as Record<string, unknown> | undefined;
          name = (metadata?.display_name as string) ?? (metadata?.name as string) ?? slug;
          role = (metadata?.description as string) ?? (roleIdentity?.primary_role as string) ?? "";
        } catch {}
      }

      const nameCol = name.padEnd(20);
      const slugCol = chalk.dim(`(${slug})`).padEnd(30);
      console.log(`  ${chalk.cyan(nameCol)} ${slugCol} ${role}`);
    }

    console.log("");
    console.log(chalk.dim("Compile a persona:"), chalk.cyan("personaxis compile .personaxis/personas/<slug>/PERSONA.md --target claude-code"));
    console.log(chalk.dim("Compile for Codex:"), chalk.cyan("personaxis compile .personaxis/personas/<slug>/PERSONA.md --target codex"));
    console.log("");
  });

export const templatesCommand = new Command("templates")
  .description("List built-in persona templates available for personaxis use")
  .action(() => {
    console.log("");
    console.log(chalk.bold("Built-in templates"));
    console.log("");

    for (const t of BUILT_IN_TEMPLATES) {
      console.log(`  ${chalk.cyan(t.slug.padEnd(22))} ${t.display}`);
    }

    console.log("");
    console.log(chalk.dim("Use a template:"), chalk.cyan("personaxis use <template> [--target claude-code|codex]"));
    console.log(chalk.dim("Archived targets:"), chalk.cyan("cursor, soul-md"));
    console.log(chalk.dim("Search registry:"), chalk.cyan("personaxis search <query>"), chalk.dim("(coming soon)"));
    console.log("");
  });
