/**
 * `personaxis orchestrate "<task>"`, the overseer routes a task across personas.
 *
 * Reads the registered personas, derives each one's capabilities from its spec,
 * posts the task to a blackboard, and shows who volunteers (ranked) and who gets
 * assigned. With --run, it executes one governed Living-Loop cycle on the assigned
 * persona with the task as an observation.
 */

import { Command } from "commander";
import { existsSync } from "node:fs";
import chalk from "chalk";
import {
  Blackboard,
  loadRegistry,
  loadPersona,
  extractCapabilities,
  getTeam,
  LivingLoop,
  HeuristicAppraiser,
  displayName,
  type Agent,
  type LoopEvent,
} from "@personaxis/core";

function registeredAgents(): { agents: Agent[]; paths: Record<string, string> } {
  const reg = loadRegistry();
  const agents: Agent[] = [];
  const paths: Record<string, string> = {};
  for (const [slug, rec] of Object.entries(reg.personas)) {
    if (!existsSync(rec.globalPath)) continue;
    const fm = loadPersona(rec.globalPath).frontmatter;
    agents.push({ id: slug, capabilities: extractCapabilities(fm) });
    paths[slug] = rec.globalPath;
  }
  return { agents, paths };
}

export const orchestrateCommand = new Command("orchestrate")
  .description("Route a task across registered personas via the blackboard (capability-matched).")
  .argument("<task>", "Task description")
  .option("--team <name>", "Restrict routing to a team's members")
  .option("--run", "Run one governed Living-Loop cycle on the assigned persona")
  .action(async (task: string, opts: { run?: boolean; team?: string }) => {
    let { agents, paths } = registeredAgents();
    if (opts.team) {
      const team = getTeam(opts.team);
      if (!team) {
        console.error(chalk.red("Error:"), `no team '${opts.team}'`);
        process.exit(1);
      }
      const members = new Set(team.members.map((m) => m.slug));
      agents = agents.filter((a) => members.has(a.id));
      console.log(chalk.dim(`  (scoped to team '${opts.team}': ${[...members].join(", ")})`));
    }
    if (agents.length === 0) {
      console.error(chalk.yellow("No registered personas with a global spec found."));
      console.error(chalk.dim("Register one: ") + chalk.cyan("personaxis overseer register <slug>"));
      process.exit(1);
    }

    const board = new Blackboard();
    const t = board.post(task);
    const ranked = board.solicit(t.id, agents);

    console.log(chalk.bold.magentaBright(`\n  overseer · routing task`));
    console.log(chalk.dim(`  "${task}"\n`));
    if (ranked.length === 0) {
      console.log(chalk.yellow("  no persona matched this task's capabilities.\n"));
      return;
    }
    console.log(chalk.bold("  Volunteers (capability-ranked)"));
    for (const v of ranked) {
      console.log(`  ${chalk.cyan(v.id.padEnd(16))} score ${v.score}  ${chalk.dim(`[${v.matched.join(", ")}]`)}`);
    }
    const assigned = board.assign(t.id, agents)!;
    console.log("\n  " + chalk.green("→ assigned:") + " " + chalk.bold(assigned.id) + chalk.dim(` (score ${assigned.score})\n`));

    if (opts.run) {
      const personaPath = paths[assigned.id];
      const loop = new LivingLoop(personaPath, { appraiser: new HeuristicAppraiser() });
      const events: LoopEvent[] = [];
      loop.bus.on((e) => events.push(e));
      const report = await loop.tick({ observation: task, source: "user", actor: "actor-llm" });
      console.log(
        chalk.dim(
          `  ${displayName(loop.persona.frontmatter)} ran a governed cycle: ` +
            `${report.mutationsApplied} mutation(s), ${report.memoriesWritten} memory write(s).\n`,
        ),
      );
    } else {
      console.log(chalk.dim("  (use --run to execute a governed Living-Loop cycle on the assignee)\n"));
    }
  });
