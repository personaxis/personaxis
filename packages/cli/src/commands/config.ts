import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, saveConfig, configPath, type PersonaxisConfig, type ConfigScope } from "../config.js";

const KNOWN_KEYS = [
  "provider",
  "local.endpoint",
  "local.model",
  "local.apiKey",
  "local.apiKeyEnv",
  "personas.<slug>.endpoint",
  "personas.<slug>.model",
  "personas.<slug>.apiKeyEnv",
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
  if (section === "local" && (field === "endpoint" || field === "model" || field === "apiKey" || field === "apiKeyEnv")) {
    config.local = { ...config.local, [field]: value };
    return;
  }
  // personas.<slug>.<field>, per-persona model overrides.
  if (section === "personas") {
    const [, slug, pField] = key.split(".");
    if (slug && (pField === "endpoint" || pField === "model" || pField === "apiKey" || pField === "apiKeyEnv")) {
      config.personas = { ...config.personas, [slug]: { ...config.personas?.[slug], [pField]: value } };
      return;
    }
    throw new Error(`Invalid personas key "${key}". Use personas.<slug>.{endpoint|model|apiKey|apiKeyEnv}`);
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
  .description(`Set a config value. Known keys: ${KNOWN_KEYS.join(", ")}`)
  .argument("<key>", "Config key, e.g. local.endpoint, personas.cmo.model, provider")
  .argument("<value>", "Value to set")
  .option("-g, --global", "Write to the global config (~/.personaxis/config.json) instead of the project", false)
  .action((key: string, value: string, opts: { global?: boolean }) => {
    const scope: ConfigScope = opts.global ? "global" : "project";
    const config = loadConfig(scope);
    try {
      setPath(config, key, value);
    } catch (err) {
      console.error(chalk.red("Error:"), (err as Error).message);
      process.exit(1);
    }
    saveConfig(config, scope);
    const isSecret = /apiKey$/.test(key) && !/apiKeyEnv$/.test(key);
    const shown = isSecret ? value.slice(0, 3) + "…" + value.slice(-2) : value; // never echo a full key
    console.log(chalk.green("✓"), `${key} = ${shown}`, chalk.dim(`(${configPath(scope)})`));
    if (isSecret) {
      if (scope === "global") console.log(chalk.dim("  stored in your home config (user-only, 0600), reused across all projects, like ~/.aws/credentials."));
      else console.log(chalk.yellow("  ! inline key in the PROJECT config, ensure .personaxis/ is gitignored, or set it --global (recommended)."));
    }
  });

const getCommand = new Command("get")
  .description("Print a config value (project overrides global)")
  .argument("<key>", "Config key")
  .option("-g, --global", "Read the global config only", false)
  .action((key: string, opts: { global?: boolean }) => {
    const scope: ConfigScope = opts.global ? "global" : "project";
    const value = getPath(loadConfig(scope), key) ?? getPath(loadConfig("global"), key);
    console.log(value === undefined ? chalk.dim("(unset)") : value);
  });

/** Redact inline apiKey values so `config show` never prints a full secret. */
function redact(cfg: PersonaxisConfig): PersonaxisConfig {
  const mask = (k?: string): string | undefined => (k ? k.slice(0, 3) + "…" + k.slice(-2) : k);
  const out = JSON.parse(JSON.stringify(cfg)) as PersonaxisConfig;
  if (out.local?.apiKey) out.local.apiKey = mask(out.local.apiKey);
  for (const p of Object.values(out.personas ?? {})) if (p.apiKey) p.apiKey = mask(p.apiKey);
  return out;
}

const showCommand = new Command("show")
  .description("Print the project + global config (keys masked) and where each file lives")
  .action(() => {
    console.log(chalk.bold("project"), chalk.dim(configPath("project")));
    console.log(JSON.stringify(redact(loadConfig("project")), null, 2));
    console.log(chalk.bold("\nglobal"), chalk.dim(configPath("global")));
    console.log(JSON.stringify(redact(loadConfig("global")), null, 2));
    console.log(chalk.dim(`\nPrecedence: env > project > global. The API key resolves from the env var named by`));
    console.log(chalk.dim(`*.apiKeyEnv, else PERSONAXIS_API_KEY, else an inline *.apiKey. Storing the key in the`));
    console.log(chalk.dim(`GLOBAL config (~/.personaxis, user-only 0600) is fine and reused across all projects.`));
  });

export const configCommand = new Command("config")
  .description("Configure the provider used by compile/decompile (local | byok | agent | remote)")
  .addCommand(setCommand)
  .addCommand(getCommand)
  .addCommand(showCommand);
