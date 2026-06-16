import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, saveConfig, configPath, type PersonaxisConfig } from "../config.js";

const KNOWN_KEYS = [
  "provider",
  "local.endpoint",
  "local.model",
  "byok.apiProvider",
  "byok.model",
  "remote.apiBase",
  "remote.model",
] as const;

const PROVIDER_VALUES = ["local", "byok", "agent", "remote"] as const;
const BYOK_API_PROVIDER_VALUES = ["anthropic", "openai"] as const;

function setPath(config: PersonaxisConfig, key: string, value: string): void {
  if (key === "provider") {
    if (!(PROVIDER_VALUES as readonly string[]).includes(value)) {
      throw new Error(`Invalid provider "${value}". Expected one of: ${PROVIDER_VALUES.join(", ")}`);
    }
    config.provider = value as PersonaxisConfig["provider"];
    return;
  }

  const [section, field] = key.split(".");
  if (section === "local" && (field === "endpoint" || field === "model")) {
    config.local = { ...config.local, [field]: value };
    return;
  }
  if (section === "byok" && field === "apiProvider") {
    if (!(BYOK_API_PROVIDER_VALUES as readonly string[]).includes(value)) {
      throw new Error(`Invalid byok.apiProvider "${value}". Expected one of: ${BYOK_API_PROVIDER_VALUES.join(", ")}`);
    }
    config.byok = { ...config.byok, apiProvider: value as "anthropic" | "openai" };
    return;
  }
  if (section === "byok" && field === "model") {
    config.byok = { ...config.byok, model: value };
    return;
  }
  if (section === "remote" && (field === "apiBase" || field === "model")) {
    config.remote = { ...config.remote, [field]: value };
    return;
  }

  throw new Error(`Unknown config key "${key}". Known keys: ${KNOWN_KEYS.join(", ")}`);
}

function getPath(config: PersonaxisConfig, key: string): string | undefined {
  if (key === "provider") return config.provider;
  const [section, field] = key.split(".");
  const sectionValue = (config as Record<string, unknown>)[section] as Record<string, unknown> | undefined;
  const value = sectionValue?.[field];
  return typeof value === "string" ? value : undefined;
}

const setCommand = new Command("set")
  .description(`Set a provider config value. Known keys: ${KNOWN_KEYS.join(", ")}`)
  .argument("<key>", "Config key, e.g. provider, local.endpoint, byok.apiProvider")
  .argument("<value>", "Value to set")
  .action((key: string, value: string) => {
    const config = loadConfig();
    try {
      setPath(config, key, value);
    } catch (err) {
      console.error(chalk.red("Error:"), (err as Error).message);
      process.exit(1);
    }
    saveConfig(config);
    console.log(chalk.green("✓"), `${key} = ${value}`, chalk.dim(`(${configPath()})`));
  });

const getCommand = new Command("get")
  .description("Print a provider config value")
  .argument("<key>", "Config key")
  .action((key: string) => {
    const config = loadConfig();
    const value = getPath(config, key);
    if (value === undefined) {
      console.log(chalk.dim("(unset)"));
      return;
    }
    console.log(value);
  });

const showCommand = new Command("show")
  .description("Print the full provider config")
  .action(() => {
    const config = loadConfig();
    console.log(JSON.stringify(config, null, 2));
    console.log(chalk.dim(`\nAPI keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, PERSONAXIS_API_TOKEN) are read from`));
    console.log(chalk.dim(`the environment and are never stored in ${configPath()}.`));
  });

export const configCommand = new Command("config")
  .description("Configure the provider used by compile/decompile (local | byok | agent | remote)")
  .addCommand(setCommand)
  .addCommand(getCommand)
  .addCommand(showCommand);
