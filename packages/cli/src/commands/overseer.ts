/**
 * `personaxis overseer` — the master view.
 *
 * personaxis-system is a governed runtime aware of every persona, project, and
 * collection across the environment (and across machines, for the portable
 * user-clone). This command prints that situational summary from the registry
 * at ~/.personaxis (override with PERSONAXIS_HOME).
 */

import { Command } from "commander";
import chalk from "chalk";
import {
  overseerView,
  registerPersona,
  registerProject,
  createCollection,
  addToCollection,
  machineId,
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
    console.log(`  ${chalk.cyan("personas")}    ${v.personas}`);
    for (const p of Object.values(v.detail.personas)) console.log(chalk.dim(`    · ${p.slug}`));
    console.log(`  ${chalk.cyan("projects")}    ${v.projects}`);
    for (const p of Object.values(v.detail.projects))
      console.log(chalk.dim(`    · ${p.root} [${p.slugs.join(", ")}]`));
    console.log(`  ${chalk.cyan("collections")} ${v.collections}`);
    for (const c of Object.values(v.detail.collections))
      console.log(chalk.dim(`    · ${c.name}: ${c.personas.length} persona(s), ${c.projects.length} project(s)`));
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

export const overseerCommand = new Command("overseer")
  .description("The master view: all personas, projects, and collections in the environment.")
  .addCommand(showCmd)
  .addCommand(registerCmd)
  .addCommand(collectionCmd);
