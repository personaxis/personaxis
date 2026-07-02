#!/usr/bin/env node
import { program } from "commander";
import { version } from "./generated/assets.js";
import { initCommand } from "./commands/init.js";
import { validateCommand } from "./commands/validate.js";
import { compileCommand } from "./commands/compile.js";
import { useCommand } from "./commands/use.js";
import { listCommand, templatesCommand } from "./commands/list.js";
import { lintCommand } from "./commands/lint.js";
import { diffCommand } from "./commands/diff.js";
import { exportCommand } from "./commands/export.js";
import { specCommand } from "./commands/spec.js";
import { templateCommand } from "./commands/template.js";
import { pullCommand } from "./commands/pull.js";
import { runtimeCommand } from "./commands/runtime.js";
import { stateCommand } from "./commands/state.js";
import { improveCommand } from "./commands/improve.js";
import { migrateCommand } from "./commands/migrate.js";
import { configCommand } from "./commands/config.js";
import { decompileCommand } from "./commands/decompile.js";
import { pushCommand } from "./commands/push.js";
import { skillsCommand } from "./commands/skills.js";
import { overseerCommand } from "./commands/overseer.js";
import { orchestrateCommand } from "./commands/orchestrate.js";
import { teamCommand } from "./commands/team.js";
import { sigilCommand } from "./commands/sigil.js";
import { dashCommand } from "./commands/dash.js";
import { syncCommand } from "./commands/sync.js";
import { serveCommand } from "./commands/serve.js";
import { observeCommand } from "./commands/observe.js";
import { watchCommand } from "./commands/watch.js";
import { hooksCommand } from "./commands/hooks.js";
import { onboardCommand } from "./commands/onboard.js";
import { personasCommand } from "./commands/personas.js";
import { traceCommand } from "./commands/trace.js";
import { scanCommand } from "./commands/scan.js";
import { startRepl } from "./repl/index.js";

// Options after a subcommand belong to that subcommand (so `sigil --persona X`
// is parsed by `sigil`, not captured by the root REPL's own --persona).
program.enablePositionalOptions();

program
  .name("personaxis")
  .description("Living, governed AI agent personas — define, validate, compile, and live.")
  .version(version)
  // `personaxis` with no subcommand enters the living REPL.
  .option("--persona <path>", "Path to the persona (personaxis.md / PERSONA.md) for the REPL")
  .action(async (opts: { persona?: string }) => {
    await startRepl({ persona: opts.persona });
  });

program.addCommand(initCommand);
program.addCommand(validateCommand);
program.addCommand(lintCommand);
program.addCommand(compileCommand);
program.addCommand(exportCommand);
program.addCommand(diffCommand);
program.addCommand(specCommand);
program.addCommand(useCommand);
program.addCommand(listCommand);
program.addCommand(templatesCommand);
program.addCommand(templateCommand);
program.addCommand(pullCommand);
program.addCommand(runtimeCommand);
program.addCommand(stateCommand);
program.addCommand(improveCommand);
program.addCommand(migrateCommand);
program.addCommand(configCommand);
program.addCommand(decompileCommand);
program.addCommand(pushCommand);
program.addCommand(skillsCommand);
program.addCommand(overseerCommand);
program.addCommand(orchestrateCommand);
program.addCommand(teamCommand);
program.addCommand(sigilCommand);
program.addCommand(dashCommand);
program.addCommand(syncCommand);
program.addCommand(serveCommand);
program.addCommand(observeCommand);
program.addCommand(watchCommand);
program.addCommand(hooksCommand);
program.addCommand(onboardCommand);
program.addCommand(personasCommand);
program.addCommand(traceCommand);
program.addCommand(scanCommand);

program.parse();
