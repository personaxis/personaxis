import type { Command } from "commander";

/**
 * Every top-level command, in the order `--help` lists them, with the names it answers to and how to load it.
 *
 * Loading is lazy on purpose. Importing all of them made every invocation pay for every command's imports:
 * 1.25 s for `--version` on 2026-10-09, half of it the Command Center's Ink and React that two commands
 * pulled in statically. `index.ts` loads only the command that was asked for, and all of them only when
 * the whole list is needed (`--help`, or a word that is not a command, so the suggestion still works).
 *
 * `command-table.test.ts` holds each entry's names to what the loaded command really answers to.
 */
export interface CommandEntry {
  readonly names: readonly string[];
  readonly load: () => Promise<Command>;
}

export const COMMAND_TABLE: readonly CommandEntry[] = [
  { names: ["init"], load: async () => (await import("./commands/init.js")).initCommand },
  { names: ["create"], load: async () => (await import("./commands/create.js")).createCommand },
  { names: ["validate"], load: async () => (await import("./commands/validate.js")).validateCommand },
  { names: ["lint"], load: async () => (await import("./commands/lint.js")).lintCommand },
  { names: ["compile"], load: async () => (await import("./commands/compile.js")).compileCommand },
  { names: ["export"], load: async () => (await import("./commands/export.js")).exportCommand },
  { names: ["diff"], load: async () => (await import("./commands/diff.js")).diffCommand },
  { names: ["spec"], load: async () => (await import("./commands/spec.js")).specCommand },
  { names: ["list"], load: async () => (await import("./commands/list.js")).listCommand },
  { names: ["pull"], load: async () => (await import("./commands/pull.js")).pullCommand },
  { names: ["runtime"], load: async () => (await import("./commands/runtime.js")).runtimeCommand },
  { names: ["connect", "login"], load: async () => (await import("./commands/connect.js")).connectCommand },
  { names: ["guard"], load: async () => (await import("./commands/guard.js")).guardCommand },
  { names: ["state"], load: async () => (await import("./commands/state.js")).stateCommand },
  { names: ["arbitrate"], load: async () => (await import("./commands/arbitrate.js")).arbitrateCommand },
  { names: ["jacobian"], load: async () => (await import("./commands/jacobian.js")).jacobianCommand },
  { names: ["proof"], load: async () => (await import("./commands/proof.js")).proofCommand },
  { names: ["status"], load: async () => (await import("./commands/inspect.js")).statusCommand },
  { names: ["audit"], load: async () => (await import("./commands/inspect.js")).auditCommand },
  { names: ["memory"], load: async () => (await import("./commands/inspect.js")).memoryCommand },
  { names: ["drift"], load: async () => (await import("./commands/inspect.js")).driftCommand },
  { names: ["goal"], load: async () => (await import("./commands/inspect.js")).goalCommand },
  { names: ["review"], load: async () => (await import("./commands/inspect.js")).reviewCommand },
  { names: ["doctor"], load: async () => (await import("./commands/inspect.js")).doctorCommand },
  { names: ["edit"], load: async () => (await import("./commands/edit.js")).editCommand },
  { names: ["improve"], load: async () => (await import("./commands/improve.js")).improveCommand },
  { names: ["migrate"], load: async () => (await import("./commands/migrate.js")).migrateCommand },
  { names: ["config"], load: async () => (await import("./commands/config.js")).configCommand },
  { names: ["model"], load: async () => (await import("./commands/model.js")).modelCommand },
  { names: ["credential"], load: async () => (await import("./commands/credential.js")).credentialCommand },
  { names: ["decompile"], load: async () => (await import("./commands/decompile.js")).decompileCommand },
  { names: ["push"], load: async () => (await import("./commands/push.js")).pushCommand },
  { names: ["skills"], load: async () => (await import("./commands/skills.js")).skillsCommand },
  { names: ["overseer"], load: async () => (await import("./commands/overseer.js")).overseerCommand },
  { names: ["orchestrate"], load: async () => (await import("./commands/orchestrate.js")).orchestrateCommand },
  { names: ["team"], load: async () => (await import("./commands/team.js")).teamCommand },
  { names: ["sigil"], load: async () => (await import("./commands/sigil.js")).sigilCommand },
  { names: ["dash"], load: async () => (await import("./commands/dash.js")).dashCommand },
  { names: ["menu"], load: async () => (await import("./commands/menu.js")).menuCommand },
  { names: ["sync"], load: async () => (await import("./commands/sync.js")).syncCommand },
  { names: ["serve"], load: async () => (await import("./commands/serve.js")).serveCommand },
  { names: ["observe"], load: async () => (await import("./commands/observe.js")).observeCommand },
  { names: ["service"], load: async () => (await import("./commands/service.js")).serviceCommand },
  { names: ["web"], load: async () => (await import("./commands/web.js")).webCommand },
  { names: ["watch"], load: async () => (await import("./commands/watch.js")).watchCommand },
  { names: ["hooks"], load: async () => (await import("./commands/hooks.js")).hooksCommand },
  { names: ["onboard"], load: async () => (await import("./commands/onboard.js")).onboardCommand },
  { names: ["personas"], load: async () => (await import("./commands/personas.js")).personasCommand },
  { names: ["trace"], load: async () => (await import("./commands/trace.js")).traceCommand },
  { names: ["scan"], load: async () => (await import("./commands/scan.js")).scanCommand },
  { names: ["lease"], load: async () => (await import("./commands/lease.js")).leaseCommand },
  { names: ["console"], load: async () => (await import("./commands/console.js")).consoleCommand },
  { names: ["sign"], load: async () => (await import("./commands/sign.js")).signCommand },
  { names: ["verify"], load: async () => (await import("./commands/sign.js")).verifyCommand },
  { names: ["attest"], load: async () => (await import("./commands/attest.js")).attestCommand },
  { names: ["mcp"], load: async () => (await import("./commands/mcp.js")).mcpCommand },
  { names: ["ps"], load: async () => (await import("./commands/ps.js")).psCommand },
  { names: ["card"], load: async () => (await import("./commands/card.js")).cardCommand },
];

const HELP = new Set(["-h", "--help", "help"]);

/**
 * The entries an invocation needs. A command named among the arguments loads alone; with no command named,
 * a run that starts with an option (the REPL, `-p`, `--version`) needs none, and anything else (help, or a
 * mistyped command that should get its suggestion) needs the whole list.
 */
export function entriesFor(args: readonly string[]): readonly CommandEntry[] {
  const named = COMMAND_TABLE.filter((entry) => entry.names.some((name) => args.includes(name)));
  if (named.length > 0) return named;
  if (args.some((arg) => HELP.has(arg))) return COMMAND_TABLE;
  if (args.length === 0 || args[0]!.startsWith("-")) return [];
  return COMMAND_TABLE;
}
