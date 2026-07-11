/**
 * FR.9, `personaxis credential` : OS-secure-storage front-end.
 *
 * The value is NEVER taken as an argv token (argv leaks into shell history
 * and process listings): it is read from stdin (piped or typed) instead.
 * Resolution order stays env-first, see src/credentials.ts.
 */

import { Command } from "commander";
import chalk from "chalk";
import { resolveCredential, storeCredential } from "../credentials.js";

async function readStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.trim();
}

const setCommand = new Command("set")
  .description("Store a credential in the OS secure store (value read from stdin, never argv)")
  .argument("<name>", "Credential name = the env var it substitutes, e.g. ANTHROPIC_API_KEY")
  .action(async (name: string) => {
    if (process.stdin.isTTY) console.log(chalk.dim(`Paste the value for ${name} and press Ctrl+${process.platform === "win32" ? "Z, Enter" : "D"}:`));
    const value = await readStdin();
    if (!value) {
      console.error(chalk.red("Error:"), "empty value, pipe it in, e.g. `echo $KEY | personaxis credential set " + name + "`");
      process.exit(1);
    }
    try {
      storeCredential(name, value);
    } catch (err) {
      console.error(chalk.red("Error:"), (err as Error).message);
      process.exit(1);
    }
    console.log(chalk.green("✓"), `${name} stored in the OS secure store (service "personaxis").`);
    console.log(chalk.dim("  Resolution stays env-first: an exported env var overrides the stored value."));
  });

const getCommand = new Command("get")
  .description("Check whether a credential resolves (prints a masked preview, never the value)")
  .argument("<name>", "Credential name, e.g. ANTHROPIC_API_KEY")
  .action((name: string) => {
    const v = resolveCredential(name);
    if (!v) {
      console.log(chalk.dim(`(unset), neither the env var ${name} nor the OS store has it`));
      process.exit(1);
    }
    const source = process.env[name] ? "environment" : "OS secure store";
    console.log(chalk.green("✓"), `${name} = ${v.slice(0, 3)}…${v.slice(-2)}`, chalk.dim(`(from ${source})`));
  });

export const credentialCommand = new Command("credential")
  .description("Manage API credentials via env vars or the OS secure store (keys never touch config files)")
  .addCommand(setCommand)
  .addCommand(getCommand);
