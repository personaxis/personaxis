#!/usr/bin/env node
import { program } from "commander";
import { version } from "./generated/assets.js";
import { checkForUpdate } from "./update-check.js";
import { noteProject } from "./project-registration.js";
import { notOffered, offered } from "./saas-gating.js";
import { entriesFor } from "./command-table.js";

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
  .description("Build a persona, the whole way a professional works, and load it into your coding agent: create, validate, compile and serve it.")
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
      // Not process.exit: right after a model call it aborts on Windows (0xC0000409) while a socket is closing.
      process.exitCode = code;
      return;
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

// L14: every command goes through one list, and what needs the Personaxis service is left out by the gating
// table (`saas-gating.ts`), so it is neither run nor listed in `--help`; the code stays for when it comes back.
// The list loads lazily: only the commands this invocation needs are imported (see `command-table.ts`).
for (const command of await Promise.all(entriesFor(process.argv.slice(2)).map((entry) => entry.load()))) {
  if (offered(command.name())) program.addCommand(command);
}

// A gated name typed anyway is told what it is and what brings it back. Without this the root command takes the word
// as an argument and answers "too many arguments", which reads as a broken command rather than one not offered yet.
const gated = notOffered(process.argv[2] ?? "");
if (gated) {
  process.stderr.write(`personaxis ${process.argv[2]} is not part of this version: it ${gated.reason}. It comes back with ${gated.returnsWith}.\n`);
  process.exit(1);
}

// FR.9, fire-and-forget update hint (daily cache; PERSONAXIS_NO_UPDATE_CHECK=1 disables).
void checkForUpdate("personaxis", version).then((latest) => {
  if (latest) {
    process.stderr.write(`\n  update available: ${version} → ${latest} · npm i -g personaxis\n`);
  }
});

program.parse();
