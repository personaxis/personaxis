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
import { noteProject } from "./project-registration.js";
import { specCommand } from "./commands/spec.js";
import { templateCommand } from "./commands/template.js";
import { pullCommand } from "./commands/pull.js";
import { runtimeCommand } from "./commands/runtime.js";
import { stateCommand } from "./commands/state.js";
import { arbitrateCommand } from "./commands/arbitrate.js";
import { jacobianCommand } from "./commands/jacobian.js";
import { createCommand } from "./commands/create.js";
import { proofCommand } from "./commands/proof.js";
// V7.H1: the non-interactive gates for capabilities that used to be slash-only, so an
// agent or a CI job can read and act on a persona without driving a menu.
import {
  statusCommand,
  auditCommand,
  memoryCommand,
  driftCommand,
  goalCommand,
  reviewCommand,
  doctorCommand,
} from "./commands/inspect.js";
import { editCommand } from "./commands/edit.js";
import { improveCommand } from "./commands/improve.js";
import { migrateCommand } from "./commands/migrate.js";
import { configCommand } from "./commands/config.js";
import { modelCommand } from "./commands/model.js";
import { credentialCommand } from "./commands/credential.js";
import { decompileCommand } from "./commands/decompile.js";
import { pushCommand } from "./commands/push.js";
import { skillsCommand } from "./commands/skills.js";
import { overseerCommand } from "./commands/overseer.js";
import { orchestrateCommand } from "./commands/orchestrate.js";
import { teamCommand } from "./commands/team.js";
import { sigilCommand } from "./commands/sigil.js";
import { dashCommand } from "./commands/dash.js";
import { menuCommand } from "./commands/menu.js";
import { syncCommand } from "./commands/sync.js";
import { serveCommand } from "./commands/serve.js";
import { observeCommand } from "./commands/observe.js";
import { watchCommand } from "./commands/watch.js";
import { hooksCommand } from "./commands/hooks.js";
import { onboardCommand } from "./commands/onboard.js";
import { personasCommand } from "./commands/personas.js";
import { traceCommand } from "./commands/trace.js";
import { scanCommand } from "./commands/scan.js";
import { signCommand, verifyCommand } from "./commands/sign.js";
import { attestCommand } from "./commands/attest.js";
import { mcpCommand } from "./commands/mcp.js";
import { psCommand } from "./commands/ps.js";
import { leaseCommand } from "./commands/lease.js";
import { consoleCommand } from "./commands/console.js";
import { cardCommand } from "./commands/card.js";

// Options after a subcommand belong to that subcommand (so `sigil --persona X`
// is parsed by `sigil`, not captured by the root REPL's own --persona).
program.enablePositionalOptions();

// V8.E1: ANY command run inside a project registers it, once, before the action runs.
// Registration used to live only in the REPL's startup, so a project you only ever
// compiled or diagnosed stayed invisible to the fleet. Best-effort and silent: it must
// never delay or fail the command that was actually asked for.
program.hook("preAction", () => {
  noteProject();
});

program
  .name("personaxis")
  .description("Living, governed AI agent personas: define, validate, compile, and live.")
  .version(version)
  // `personaxis` with no subcommand enters the living REPL.
  .option("--persona <path>", "Path to the persona (personaxis.md / PERSONA.md) for the REPL")
  .option("-c, --continue", "Resume the most recent conversation for this persona")
  .option("-r, --resume [id]", "Resume a saved conversation by id/name (lists them when the id is omitted)")
  .option("-p, --print [prompt]", "Headless: run one turn and print the reply, then exit (reads stdin if no prompt is given)")
  .option("--output-format <fmt>", "Output format for --print: text | json | stream-json", "text")
  .action(async (opts: {
    persona?: string;
    continue?: boolean;
    resume?: string | boolean;
    print?: string | boolean;
    outputFormat?: string;
  }) => {
    // Headless one-shot (V2-F3.A6): `-p` runs a single turn and exits, no Ink.
    if (opts.print !== undefined) {
      let prompt = typeof opts.print === "string" ? opts.print : "";
      if (!prompt && !process.stdin.isTTY) {
        const { readFileSync } = await import("node:fs");
        prompt = readFileSync(0, "utf-8");
      }
      const { runHeadless } = await import("./repl/headless.js");
      const code = await runHeadless({
        persona: opts.persona,
        prompt,
        format: (opts.outputFormat as "text" | "json" | "stream-json") ?? "text",
      });
      process.exit(code);
    }
    // Lazy: the REPL pulls in Ink/React (~1 s of import cost), only the
    // no-subcommand path pays it, never `validate`/CI/hook invocations.
    const { startRepl } = await import("./repl/index.js");
    await startRepl({
      persona: opts.persona,
      continueLast: opts.continue === true,
      resume: opts.resume === true ? "" : typeof opts.resume === "string" ? opts.resume : undefined,
    });
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
program.addCommand(statusCommand);
program.addCommand(auditCommand);
program.addCommand(memoryCommand);
program.addCommand(driftCommand);
program.addCommand(goalCommand);
program.addCommand(reviewCommand);
program.addCommand(doctorCommand);
program.addCommand(editCommand);
program.addCommand(improveCommand);
program.addCommand(migrateCommand);
program.addCommand(configCommand);
program.addCommand(modelCommand);
program.addCommand(credentialCommand);
program.addCommand(decompileCommand);
program.addCommand(pushCommand);
program.addCommand(skillsCommand);
program.addCommand(overseerCommand);
program.addCommand(orchestrateCommand);
program.addCommand(teamCommand);
program.addCommand(sigilCommand);
program.addCommand(dashCommand);
program.addCommand(menuCommand);
program.addCommand(syncCommand);
program.addCommand(serveCommand);
program.addCommand(observeCommand);
program.addCommand(watchCommand);
program.addCommand(hooksCommand);
program.addCommand(onboardCommand);
program.addCommand(personasCommand);
program.addCommand(traceCommand);
program.addCommand(scanCommand);
program.addCommand(leaseCommand);
program.addCommand(consoleCommand);
program.addCommand(signCommand);
program.addCommand(verifyCommand);
program.addCommand(attestCommand);
program.addCommand(mcpCommand);
program.addCommand(psCommand);
program.addCommand(cardCommand);

// FR.9, fire-and-forget update hint (daily cache; PERSONAXIS_NO_UPDATE_CHECK=1 disables).
void checkForUpdate("personaxis", version).then((latest) => {
  if (latest) {
    process.stderr.write(`\n  update available: ${version} → ${latest} · npm i -g personaxis\n`);
  }
});

program.parse();
