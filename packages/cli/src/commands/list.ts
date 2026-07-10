/**
 * `personaxis list` — the personas installed in THIS project.
 *
 * Reads each persona's quantitative spec (personaxis.md, the source of truth)
 * rather than the compiled document, and prints working next steps. Rebuilt in
 * the FASE 7 PB review: the old version read the dropped `metadata.display_name`
 * from PERSONA.md and hinted at removed commands (`use`, `compile --target`).
 */

import { Command } from "commander";
import { existsSync, readdirSync, statSync } from "fs";
import { resolve, join } from "path";
import chalk from "chalk";
import matter from "gray-matter";

export const listCommand = new Command("list")
  .description("List personas installed in THIS project (.personaxis/personas/). See also: `template` (authoring scaffolds).")
  .action(() => {
    const personasDir = resolve(process.cwd(), ".personaxis", "personas");
    const rootSpec = resolve(process.cwd(), ".personaxis", "personaxis.md");

    const entries = existsSync(personasDir)
      ? readdirSync(personasDir).filter((name) => statSync(join(personasDir, name)).isDirectory())
      : [];

    if (!existsSync(rootSpec) && entries.length === 0) {
      console.log("");
      console.log(chalk.dim("No personas found in .personaxis/"));
      console.log(chalk.dim("Create one:"), chalk.cyan("personaxis create <slug>"), chalk.dim("(interview, --from-prompt, --from-project, --from-import, --from-transcript)"));
      console.log(chalk.dim("Or scaffold the commented template:"), chalk.cyan("personaxis init"));
      console.log("");
      return;
    }

    console.log("");
    console.log(chalk.bold("Installed personas"));
    console.log("");

    const row = (slug: string, specPath: string, isRoot: boolean): void => {
      let name = slug;
      let role = "";
      if (existsSync(specPath)) {
        try {
          const parsed = matter.read(specPath);
          const identity = parsed.data.identity as Record<string, unknown> | undefined;
          const metadata = parsed.data.metadata as Record<string, unknown> | undefined;
          const roleIdentity = identity?.role_identity as Record<string, unknown> | undefined;
          name = (identity?.display_name as string) ?? (metadata?.name as string) ?? slug;
          role = (metadata?.description as string) ?? (roleIdentity?.primary_role as string) ?? "";
        } catch {
          /* an unparseable spec still gets listed by slug */
        }
      }
      const label = isRoot ? "root" : slug;
      console.log(`  ${chalk.cyan(name.padEnd(20))} ${chalk.dim(`(${label})`).padEnd(32)} ${role}`);
    };

    if (existsSync(rootSpec)) row("root", rootSpec, true);
    for (const slug of entries) row(slug, join(personasDir, slug, "personaxis.md"), false);

    console.log("");
    console.log(chalk.dim("Talk to one:"), chalk.cyan("personaxis --persona .personaxis/personas/<slug>/personaxis.md"));
    console.log(chalk.dim("Place into a coding agent:"), chalk.cyan("personaxis compile <slug> --platform claude-code|codex"));
    console.log("");
  });
