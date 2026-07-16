import { Command } from "commander";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { loadConfig, saveConfig, configPath, type PersonaxisConfig, type ConfigScope } from "../config.js";
import { runConfigMenu } from "../config-wizard.js";
import { runCommandCenter } from "../command-center.js";
import { resolvePersonaSourcePath } from "../load.js";

/** Sub-persona slugs under `.personaxis/personas/` (for the interactive per-persona assignment). */
function personaSlugs(cwd: string): string[] {
  const dir = join(cwd, ".personaxis", "personas");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

const KNOWN_KEYS = [
  "provider",
  "local.endpoint",
  "local.model",
  "local.apiKey",
  "local.apiKeyEnv",
  "profiles.<name>.provider",
  "profiles.<name>.endpoint",
  "profiles.<name>.model",
  "profiles.<name>.apiKey",
  "profiles.<name>.apiKeyEnv",
  "profiles.<name>.apiProvider",
  "profiles.<name>.apiBase",
  "defaultProfile",
  "personas.<slug>.endpoint",
  "personas.<slug>.model",
  "personas.<slug>.apiKeyEnv",
  "personas.<slug>.profile",
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
  if (key === "defaultProfile") {
    config.defaultProfile = value;
    return;
  }
  // profiles.<name>.<field>, a named library of reusable model profiles (any provider kind).
  if (section === "profiles") {
    const [, name, pField] = key.split(".");
    if (name && pField === "provider" && !(PROVIDER_VALUES as readonly string[]).includes(value)) {
      throw new Error(`Invalid profiles.${name}.provider "${value}". Expected one of: ${PROVIDER_VALUES.join(", ")}`);
    }
    if (name && pField === "apiProvider" && !(BYOK_API_PROVIDER_VALUES as readonly string[]).includes(value)) {
      throw new Error(`Invalid profiles.${name}.apiProvider "${value}". Expected one of: ${BYOK_API_PROVIDER_VALUES.join(", ")}`);
    }
    const PROFILE_FIELDS = ["provider", "endpoint", "model", "apiKey", "apiKeyEnv", "apiProvider", "apiBase"];
    if (name && PROFILE_FIELDS.includes(pField)) {
      config.profiles = { ...config.profiles, [name]: { ...config.profiles?.[name], [pField]: value } };
      return;
    }
    throw new Error(`Invalid profiles key "${key}". Use profiles.<name>.{${PROFILE_FIELDS.join("|")}}`);
  }
  // personas.<slug>.<field>, per-persona model overrides (a profile ref or inline fields).
  if (section === "personas") {
    const [, slug, pField] = key.split(".");
    if (slug && (pField === "endpoint" || pField === "model" || pField === "apiKey" || pField === "apiKeyEnv" || pField === "profile")) {
      config.personas = { ...config.personas, [slug]: { ...config.personas?.[slug], [pField]: value } };
      return;
    }
    throw new Error(`Invalid personas key "${key}". Use personas.<slug>.{endpoint|model|apiKey|apiKeyEnv|profile}`);
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

const useCommand = new Command("use")
  .description("Set a named profile as the default, or assign it to a persona")
  .argument("<profile>", "Profile name (must exist under `profiles`)")
  .option("--persona <slug>", "Assign to this persona instead of the scope default")
  .option("-g, --global", "Write to the global config (~/.personaxis/config.json)", false)
  .action((profile: string, opts: { persona?: string; global?: boolean }) => {
    const scope: ConfigScope = opts.global ? "global" : "project";
    const config = loadConfig(scope);
    const known = config.profiles?.[profile] ?? loadConfig("global").profiles?.[profile];
    if (!known) {
      console.error(chalk.red("Error:"), `no profile "${profile}". Add it first: personaxis config set profiles.${profile}.endpoint <url> (and .model).`);
      process.exit(1);
    }
    if (opts.persona) {
      config.personas = { ...config.personas, [opts.persona]: { ...config.personas?.[opts.persona], profile } };
    } else {
      config.defaultProfile = profile;
    }
    saveConfig(config, scope);
    const target = opts.persona ? `persona ${opts.persona}` : "default";
    console.log(chalk.green("✓"), `${target} → ${profile}`, chalk.dim(`(${configPath(scope)})`));
  });

export const configCommand = new Command("config")
  .description("Configure the model + provider (profiles, default, per-persona; local | byok | agent | remote)")
  .addCommand(setCommand)
  .addCommand(getCommand)
  .addCommand(showCommand)
  .addCommand(useCommand)
  // Bare `personaxis config` (no subcommand): the Command Center's Model section on
  // a TTY (a stable alt-screen modal, no residue), else the read-only show / readline.
  .action(async () => {
    if (!stdin.isTTY) {
      console.log(chalk.bold("project"), chalk.dim(configPath("project")));
      console.log(JSON.stringify(redact(loadConfig("project")), null, 2));
      console.log(chalk.bold("\nglobal"), chalk.dim(configPath("global")));
      console.log(JSON.stringify(redact(loadConfig("global")), null, 2));
      return;
    }
    if (!process.env.PERSONAXIS_NO_INK) {
      let personaPath: string | undefined;
      try {
        personaPath = resolvePersonaSourcePath();
      } catch {
        personaPath = undefined;
      }
      await runCommandCenter({ personaPath, personas: personaSlugs(process.cwd()), cwd: process.cwd(), section: "model" });
      return;
    }
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      await runConfigMenu(rl, { cwd: process.cwd(), personas: personaSlugs(process.cwd()) });
    } finally {
      rl.close();
    }
  });
