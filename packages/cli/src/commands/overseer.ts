/**
 * `personaxis overseer`, the master view.
 *
 * personaxis-system is a governed runtime aware of every persona, project, and
 * collection across the environment (and across machines, for the portable
 * user-clone). This command prints that situational summary from the registry
 * at ~/.personaxis (override with PERSONAXIS_HOME).
 */

import { Command } from "commander";
import chalk from "chalk";
import { loadMergedConfig } from "../config.js";
import {
  overseerView,
  registerPersona,
  registerProject,
  createCollection,
  addToCollection,
  machineId,
  scanForProjects,
} from "@personaxis/core";

const showCmd = new Command("show")
  .description("Show the overseer's view of all personas, projects, and collections.")
  .option("--json", "Raw JSON")
  .action((opts: { json?: boolean }) => {
    const v = overseerView();
    if (opts.json) {
      console.log(JSON.stringify(v, null, 2));
      return;
    }
    console.log(chalk.bold.magentaBright("\n  personaxis · overseer"));
    console.log(chalk.dim(`  machine ${v.machine} · ${v.machines} machine(s) known\n`));
    // The number a person expects is "how many personas do I have", which is the
    // one ACROSS projects. The global count (personas living in ~/.personaxis
    // rather than inside a project) is a different, much rarer thing, and printing
    // only that is why this view read "personas 0" next to a list of projects that
    // obviously had personas in them.
    console.log(`  ${chalk.cyan("personas")}    ${v.personasInProjects}` + chalk.dim("  (main + subs, across every project below)"));
    if (v.homePersona) console.log(`  ${chalk.cyan("yours")}       1` + chalk.dim(`  (your own persona: ${v.homePersona})`));
    console.log(`  ${chalk.cyan("global")}      ${v.personas}` + chalk.dim("  (shared personas under ~/.personaxis/personas/, reusable across projects)"));
    for (const p of Object.values(v.detail.personas)) console.log(chalk.dim(`    · ${p.slug}`));
    console.log(`  ${chalk.cyan("projects")}    ${v.projects}`);
    for (const p of Object.values(v.detail.projects)) {
      const subs = p.slugs.length ? `main + ${p.slugs.join(", ")}` : "main";
      console.log(chalk.dim(`    · ${p.root} [${subs}]`));
    }
    console.log(`  ${chalk.cyan("collections")} ${v.collections}` + chalk.dim("  (grouping/taxonomy)"));
    for (const c of Object.values(v.detail.collections))
      console.log(chalk.dim(`    · ${c.name}: ${c.personas.length} persona(s), ${c.projects.length} project(s)`));
    console.log(`  ${chalk.cyan("teams")}       ${v.teams}` + chalk.dim("  (operational: roles + goal, `personaxis team show`)"));
    for (const t of Object.values(v.detail.teams ?? {}))
      console.log(chalk.dim(`    · ${t.name}: ${t.members.length} member(s)` + (t.lead ? `, lead ${t.lead}` : "")));
    console.log("");
  });

const registerCmd = new Command("register")
  .description("Register the current project (and personas) with the overseer.")
  .argument("<slug...>", "Persona slug(s) used in this project")
  .action((slugs: string[]) => {
    for (const s of slugs) registerPersona(s);
    registerProject(process.cwd(), slugs);
    console.log(chalk.green("✓"), `registered project ${process.cwd()} with [${slugs.join(", ")}] on machine ${machineId()}`);
  });

const collectionCmd = new Command("collection")
  .description("Create a collection (team) and add personas/projects to it.")
  .argument("<name>", "Collection name")
  .option("--add-persona <slug>", "Add a persona to the collection")
  .option("--add-project <path>", "Add a project to the collection")
  .action((name: string, opts: { addPersona?: string; addProject?: string }) => {
    createCollection(name);
    if (opts.addPersona) addToCollection(name, "persona", opts.addPersona);
    if (opts.addProject) addToCollection(name, "project", opts.addProject);
    console.log(chalk.green("✓"), `collection '${name}' updated`);
  });

/**
 * V8.E2: fill the registry from the disk, under the roots the user declared.
 *
 * The fleet showed one project to someone with ten because nothing ever looked at the
 * filesystem: a project only existed once the REPL had been opened inside it. This looks,
 * but only where it was told to (`scanRoots` in the config, or `--root` here), and only
 * when asked.
 */
const scanCmd = new Command("scan")
  .description("Find projects with personas under the folders you declared (config: scanRoots)")
  .option("-r, --root <dir...>", "Scan these folders instead of the configured ones")
  .option("--depth <n>", "How deep to walk (default 4)", "4")
  .option("--json", "Raw JSON")
  .action((opts: { root?: string[]; depth: string; json?: boolean }) => {
    const roots = opts.root?.length ? opts.root : (loadMergedConfig().scanRoots ?? []);
    if (!roots.length) {
      console.error(
        chalk.yellow("  no folders to scan.") +
          chalk.dim("\n  Declare them once:  personaxis config set scanRoots '[\"~/Documents/GitHub\"]'") +
          chalk.dim("\n  or scan ad hoc:     personaxis overseer scan --root ~/Documents/GitHub") +
          chalk.dim("\n  (nothing is scanned automatically: walking your disk uninvited is not a feature)"),
      );
      process.exit(2);
    }
    const res = scanForProjects(roots, Number(opts.depth) || 4);
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    for (const r of res.missingRoots) console.error(chalk.yellow(`  ! no such folder: ${r}`));
    if (!res.found.length) {
      console.log(chalk.dim(`  no projects with a persona under ${roots.join(", ")} (${res.scanned} folder(s) walked).`));
      return;
    }
    console.log(chalk.green(`✓ ${res.found.length} project(s)`) + chalk.dim(` · ${res.scanned} folder(s) walked`));
    for (const p of res.found) {
      const subs = p.slugs.length ? `main + ${p.slugs.join(", ")}` : "main";
      console.log(chalk.dim(`    · ${p.root} [${subs}]`) + (p.origin ? chalk.dim(`  ← ${p.origin}`) : ""));
    }
  });

export const overseerCommand = new Command("overseer")
  .description("The master view: all personas, projects, and collections in the environment.")
  .addCommand(showCmd)
  .addCommand(registerCmd)
  .addCommand(scanCmd)
  .addCommand(collectionCmd);
