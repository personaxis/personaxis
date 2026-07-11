/**
 * `personaxis personas …`, make the global + overlay reuse model usable (G5).
 *
 * A persona lives GLOBALLY at ~/.personaxis/personas/<slug>/personaxis.md (identity
 * + accumulated memory). A project ADOPTS it as an overlay under
 * .personaxis/personas/<slug>/ with its own state.json, so the same persona can be
 * reused across projects (with shared identity) while each project keeps its own
 * runtime state. The primitives lived in @personaxis/core/registry; this surfaces
 * them as discoverable commands.
 */

import { Command } from "commander";
import { existsSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import chalk from "chalk";
import {
  loadPersona,
  ensureState,
  displayName,
  globalPersonaDir,
  registerPersona,
  registerProject,
  resolveEffectivePersona,
  loadRegistry,
} from "@personaxis/core";

function globalPath(slug: string): string {
  return join(globalPersonaDir(slug), "personaxis.md");
}

const listCmd = new Command("list")
  .description("List personas installed globally (reusable across projects).")
  .action(() => {
    const reg = loadRegistry();
    const slugs = Object.keys(reg.personas);
    if (slugs.length === 0) {
      console.log(chalk.dim("  No global personas yet. ") + chalk.cyan("personaxis personas import <path>") + chalk.dim(" to add one."));
      return;
    }
    console.log(chalk.bold("\n  Global personas\n"));
    for (const slug of slugs) {
      const p = globalPath(slug);
      let name = slug;
      try {
        if (existsSync(p)) name = displayName(loadPersona(p).frontmatter);
      } catch {
        /* keep slug */
      }
      console.log(`  ${chalk.cyan(slug.padEnd(20))} ${chalk.dim(name)}${existsSync(p) ? "" : chalk.red("  (missing file)")}`);
    }
    console.log("");
  });

const importCmd = new Command("import")
  .description("Register a persona file as a reusable global persona.")
  .argument("<path>", "Path to a personaxis.md to import")
  .option("--slug <slug>", "Slug to register it under (defaults to the persona's canonical_id)")
  .action((path: string, opts: { slug?: string }) => {
    const src = resolve(path);
    if (!existsSync(src)) {
      console.error(chalk.red("Error:"), `no file at ${src}`);
      process.exit(1);
    }
    const handle = loadPersona(src); // throws if unparseable
    const id = handle.frontmatter.identity as { canonical_id?: string } | undefined;
    const slug = opts.slug ?? id?.canonical_id ?? displayName(handle.frontmatter).toLowerCase().replace(/\s+/g, "-");
    const dest = globalPath(slug);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    registerPersona(slug);
    console.log(chalk.green("  ✓"), `imported ${chalk.bold(displayName(handle.frontmatter))} as global persona ${chalk.cyan(slug)}`);
    console.log(chalk.dim(`    ${dest}`));
    console.log(chalk.dim(`    adopt it in a project: `) + chalk.cyan(`personaxis personas adopt ${slug}`));
  });

const exportCmd = new Command("export")
  .description("Copy a global persona out to a file.")
  .argument("<slug>", "Global persona slug")
  .argument("<dest>", "Destination path")
  .action((slug: string, dest: string) => {
    const src = globalPath(slug);
    if (!existsSync(src)) {
      console.error(chalk.red("Error:"), `no global persona '${slug}'. See ` + chalk.cyan("personaxis personas list"));
      process.exit(1);
    }
    const out = resolve(dest);
    mkdirSync(dirname(out), { recursive: true });
    copyFileSync(src, out);
    console.log(chalk.green("  ✓"), `exported ${chalk.cyan(slug)} → ${out}`);
  });

const adoptCmd = new Command("adopt")
  .description("Adopt a global persona into THIS project as an overlay (own state.json).")
  .argument("<slug>", "Global persona slug to adopt")
  .action((slug: string) => {
    const src = globalPath(slug);
    if (!existsSync(src)) {
      console.error(chalk.red("Error:"), `no global persona '${slug}'. Import one first: ` + chalk.cyan("personaxis personas import <path>"));
      process.exit(1);
    }
    const overlayDir = join(process.cwd(), ".personaxis", "personas", slug);
    const overlayPath = join(overlayDir, "personaxis.md");
    if (existsSync(overlayPath)) {
      console.log(chalk.yellow("  already adopted:"), overlayPath);
    } else {
      mkdirSync(overlayDir, { recursive: true });
      copyFileSync(src, overlayPath);
    }
    ensureState(loadPersona(overlayPath)); // seed the project-local state overlay
    registerPersona(slug);
    registerProject(process.cwd(), [slug]);
    const eff = resolveEffectivePersona(process.cwd(), slug);
    console.log(chalk.green("  ✓"), `adopted ${chalk.cyan(slug)} (${eff.scope})`);
    console.log(chalk.dim("    run it: ") + chalk.cyan(`personaxis --persona ${slug}`));
  });

export const personasCommand = new Command("personas")
  .description("Manage reusable global personas (global + project overlay).")
  .addCommand(listCmd)
  .addCommand(importCmd)
  .addCommand(exportCmd)
  .addCommand(adoptCmd);
