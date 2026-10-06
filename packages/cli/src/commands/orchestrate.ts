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
  run,
  displayName,
  type Agent,
  type LoopEvent,
} from "@personaxis/core";
import { holdPresence } from "../presence-session.js";

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
      const events: LoopEvent[] = [];
      // Through the seam, which changes what appraises the assignee: it used to be
      // pinned to the heuristic appraiser with no reason written anywhere, so the same
      // persona evolved one way here and another way under `observe`. An orchestrator
      // deciding a persona is appraised by something it never declared is the thing
      // the identity axis exists to prevent, and it was doing it to itself.
      const loop = run.evolverFor(
        { personaPath, frontmatter: loadPersona(personaPath).frontmatter as Record<string, unknown> },
        { recompile: null, onEvent: (e: LoopEvent) => events.push(e) },
      );
      // D6: the assignee is being driven by someone who is not sitting in front of it. That
      // is the presence a second operator most needs to see, and it names the task.
      const presence = holdPresence(personaPath, { host: "task", activity: `assigned task: ${task.slice(0, 60)}` });
      let report;
      try {
        report = await loop.observe({ observation: task, source: "user", actor: "actor-llm" });
      } finally {
        presence.release();
      }
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
