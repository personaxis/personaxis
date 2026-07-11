/**
 * `personaxis team`, operational multi-agent units (distinct from collections).
 *
 * A Collection is taxonomy (a folder of personas). A TEAM is operational: personas
 * with ROLES, a shared GOAL, that collaborate (e.g. `orchestrate --team <name>`
 * routes a task only among the team's members).
 */

import { Command } from "commander";
import chalk from "chalk";
import { createTeam, addTeamMember, setTeamGoal, getTeam, loadRegistry } from "@personaxis/core";

const createCmd = new Command("create")
  .description("Create a team, optionally with a lead persona.")
  .argument("<name>", "Team name")
  .option("--lead <slug>", "Lead persona slug")
  .action((name: string, opts: { lead?: string }) => {
    const t = createTeam(name, opts.lead);
    console.log(chalk.green("✓"), `team '${t.name}' created` + (t.lead ? ` (lead: ${t.lead})` : ""));
  });

const addCmd = new Command("add")
  .description("Add a persona to a team with a role.")
  .argument("<name>", "Team name")
  .argument("<slug>", "Persona slug")
  .option("--role <role>", "Role on the team", "member")
  .action((name: string, slug: string, opts: { role: string }) => {
    addTeamMember(name, slug, opts.role);
    console.log(chalk.green("✓"), `${slug} added to '${name}' as ${opts.role}`);
  });

const goalCmd = new Command("goal")
  .description("Set the team's shared goal.")
  .argument("<name>", "Team name")
  .argument("<goal...>", "Goal text")
  .action((name: string, goal: string[]) => {
    setTeamGoal(name, goal.join(" "));
    console.log(chalk.green("✓"), `goal set for '${name}'`);
  });

const showCmd = new Command("show")
  .description("Show a team (or all teams).")
  .argument("[name]", "Team name (omit to list all)")
  .action((name?: string) => {
    const reg = loadRegistry();
    const teams = name ? (getTeam(name) ? [getTeam(name)!] : []) : Object.values(reg.teams ?? {});
    if (teams.length === 0) {
      console.log(chalk.yellow(name ? `no team '${name}'` : "no teams yet."));
      return;
    }
    for (const t of teams) {
      console.log("\n" + chalk.bold.magentaBright(`  ${t.name}`) + (t.lead ? chalk.dim(`  · lead: ${t.lead}`) : ""));
      if (t.goal) console.log(chalk.dim(`  goal: ${t.goal}`));
      for (const m of t.members) console.log(`    ${chalk.cyan(m.slug.padEnd(18))} ${chalk.dim(m.role)}`);
    }
    console.log("");
  });

export const teamCommand = new Command("team")
  .description("Operational multi-agent teams (roles + shared goal); see also: collections in `overseer`.")
  .addCommand(createCmd)
  .addCommand(addCmd)
  .addCommand(goalCmd)
  .addCommand(showCmd);
