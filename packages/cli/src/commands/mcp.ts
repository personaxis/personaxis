/**
 * `personaxis mcp` (V2-F3.B11), the MCP CLIENT surface: register/list/remove the
 * stdio MCP servers this persona can mount as tools. This is the inverse of the
 * `@personaxis/mcp` server (which exposes personaxis TO a host); here personaxis
 * is the client that consumes other MCP servers.
 *
 * Config only for now (`config.mcpServers`); mounting the registered servers'
 * tools into the live agent loop (with a `server:` prefix) is the follow-up.
 */

import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, saveConfig } from "../config.js";

export const mcpCommand = new Command("mcp").description(
  "manage MCP servers this persona mounts as tools (client side)",
);

mcpCommand
  .command("add <name> <command> [args...]")
  .description("register a stdio MCP server: mcp add <name> <command> [args...]")
  .option("-g, --global", "write to the global config instead of the project")
  .action((name: string, command: string, args: string[], opts: { global?: boolean }) => {
    const scope = opts.global ? "global" : "project";
    const config = loadConfig(scope);
    config.mcpServers = config.mcpServers ?? {};
    config.mcpServers[name] = { command, ...(args && args.length ? { args } : {}) };
    saveConfig(config, scope);
    console.log(
      chalk.green(`✓ added MCP server "${name}"`) +
        chalk.dim(` (${scope}): ${command}${args && args.length ? " " + args.join(" ") : ""}`),
    );
  });

mcpCommand
  .command("list")
  .alias("ls")
  .description("list registered MCP servers (project overrides global)")
  .action(() => {
    const project = loadConfig("project").mcpServers ?? {};
    const global = loadConfig("global").mcpServers ?? {};
    const all = { ...global, ...project };
    const names = Object.keys(all);
    if (!names.length) {
      console.log(chalk.dim("no MCP servers registered. Add one: personaxis mcp add <name> <command>"));
      return;
    }
    for (const n of names) {
      const s = all[n];
      const scope = n in project ? "project" : "global";
      console.log(`${chalk.cyan(n)} ${chalk.dim(`(${scope})`)}  ${s.command}${s.args?.length ? " " + s.args.join(" ") : ""}`);
    }
  });

mcpCommand
  .command("remove <name>")
  .alias("rm")
  .description("unregister an MCP server")
  .option("-g, --global", "remove from the global config")
  .action((name: string, opts: { global?: boolean }) => {
    const scope = opts.global ? "global" : "project";
    const config = loadConfig(scope);
    if (!config.mcpServers?.[name]) {
      console.log(chalk.yellow(`no MCP server "${name}" in the ${scope} config`));
      return;
    }
    delete config.mcpServers[name];
    saveConfig(config, scope);
    console.log(chalk.green(`✓ removed MCP server "${name}" (${scope})`));
  });
