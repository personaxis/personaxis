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
import { describe, describeAssurance } from "@personaxis/core";

import { approve } from "../mcp/approvals.js";
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
    // K9: registering by hand IS the consent, so the approval is recorded here, at the
    // moment somebody decided. It goes to the operator's home whatever scope the config
    // went to, because a project config is inside the workspace a persona writes to and
    // an approval kept beside the thing it attests is worth nothing.
    const provenance = approve({
      name,
      command,
      ...(args && args.length ? { args } : {}),
    });
    console.log(
      chalk.green(`✓ added MCP server "${name}"`) +
        chalk.dim(` (${scope}): ${command}${args && args.length ? " " + args.join(" ") : ""}`),
    );
    console.log(chalk.dim(`  ${describeAssurance(provenance)}`));
  });

mcpCommand
  .command("approve [name]")
  .description("record the declaration of a registered server as approved")
  .action((name?: string) => {
    // The upgrade path, and the only one. A server registered before approvals existed
    // has no record, so it does not mount; recording it silently on first sight would
    // be trusting whatever is in the config right now, which is exactly what a persona
    // could have written yesterday. This makes it a decision somebody takes.
    const servers = {
      ...(loadConfig("global").mcpServers ?? {}),
      ...(loadConfig("project").mcpServers ?? {}),
    };
    const names = name ? [name] : Object.keys(servers);

    if (!names.length) {
      console.log(chalk.dim("no MCP servers registered."));
      return;
    }

    for (const each of names) {
      const spec = servers[each];
      if (!spec) {
        console.error(chalk.red(`no MCP server named "${each}" is registered.`));
        continue;
      }
      const provenance = approve({
        name: each,
        command: spec.command,
        ...(spec.args ? { args: spec.args } : {}),
        ...(spec.env ? { envKeys: Object.keys(spec.env) } : {}),
      });
      console.log(
        chalk.green(`✓ approved "${each}"`) + chalk.dim(`: ${describe({ name: each, command: spec.command, ...(spec.args ? { args: spec.args } : {}) })}`),
      );
      console.log(chalk.dim(`  ${describeAssurance(provenance)}`));
    }
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
