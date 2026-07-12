#!/usr/bin/env node
import { program } from "commander";
import { version } from "./generated/assets.js";
import { checkForUpdate } from "./update-check.js";
import { initCommand } from "./commands/init.js";
import { validateCommand } from "./commands/validate.js";
import { compileCommand } from "./commands/compile.js";
import { listCommand } from "./commands/list.js";
import { lintCommand } from "./commands/lint.js";
import { diffCommand } from "./commands/diff.js";
import { exportCommand } from "./commands/export.js";
import { specCommand } from "./commands/spec.js";
import { templateCommand } from "./commands/template.js";
import { pullCommand } from "./commands/pull.js";
import { runtimeCommand } from "./commands/runtime.js";
import { stateCommand } from "./commands/state.js";
import { arbitrateCommand } from "./commands/arbitrate.js";
import { jacobianCommand } from "./commands/jacobian.js";
import { createCommand } from "./commands/create.js";
import { proofCommand } from "./commands/proof.js";
import { editCommand } from "./commands/edit.js";
import { improveCommand } from "./commands/improve.js";
import { migrateCommand } from "./commands/migrate.js";
import { configCommand } from "./commands/config.js";
import { credentialCommand } from "./commands/credential.js";
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

// Options after a subcommand belong to that subcommand (so `sigil --persona X`
// is parsed by `sigil`, not captured by the root REPL's own --persona).
program.enablePositionalOptions();

program
  .name("personaxis")
  .description("Living, governed AI agent personas: define, validate, compile, and live.")
  .version(version)
  // `personaxis` with no subcommand enters the living REPL.
  .option("--persona <path>", "Path to the persona (personaxis.md / PERSONA.md) for the REPL")
  .action(async (opts: { persona?: string }) => {
    // Lazy: the REPL pulls in Ink/React (~1 s of import cost), only the
    // no-subcommand path pays it, never `validate`/CI/hook invocations.
    const { startRepl } = await import("./repl/index.js");
    await startRepl({ persona: opts.persona });
  });

program.addCommand(initCommand);
program.addCommand(createCommand);
program.addCommand(validateCommand);
program.addCommand(lintCommand);
program.addCommand(compileCommand);
program.addCommand(exportCommand);
program.addCommand(diffCommand);
program.addCommand(specCommand);
program.addCommand(listCommand);
program.addCommand(templateCommand);
program.addCommand(pullCommand);
program.addCommand(runtimeCommand);
program.addCommand(stateCommand);
program.addCommand(arbitrateCommand);
program.addCommand(jacobianCommand);
program.addCommand(proofCommand);
program.addCommand(editCommand);
program.addCommand(improveCommand);
program.addCommand(migrateCommand);
program.addCommand(configCommand);
program.addCommand(credentialCommand);
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

// FR.9, fire-and-forget update hint (daily cache; PERSONAXIS_NO_UPDATE_CHECK=1 disables).
void checkForUpdate("personaxis", version).then((latest) => {
  if (latest) {
    process.stderr.write(`\n  update available: ${version} → ${latest} · npm i -g personaxis\n`);
  }
});

program.parse();
