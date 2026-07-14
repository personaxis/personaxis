/**
 * Interactive model configuration: the friendly layer over the config engine
 * (@personaxis/core `resolveModel`). Two entry points, both driven by readline so they work
 * pre-Ink (first run) and inside a REPL suspension (`/config`):
 *
 *   runModelSetup   step-by-step: define ONE profile (local or cloud), save + optionally default.
 *   runConfigMenu   a loop: add/edit profiles, set the default, assign a profile to a persona, show.
 *
 * The pure builders (buildSettingsFromAnswers, upsert/remove/setDefault/assign) hold zero IO so they
 * are unit-tested directly; the readline functions only gather answers and call them. Everything
 * writes to config.json via loadConfig/saveConfig; the API key is never required in a file (prefer
 * an env var by name). Global scope is the default so one setup works in every project.
 */

import type { Interface as ReadlineInterface } from "node:readline/promises";
import { stdout } from "node:process";
import chalk from "chalk";
import { describeModel, type ModelSettings } from "@personaxis/core";
import { loadConfig, saveConfig, configPath, type ConfigScope, type PersonaxisConfig } from "./config.js";

// ── Pure builders (no IO, unit-tested) ───────────────────────────────────────

export interface ProfileAnswers {
  kind: "local" | "cloud";
  endpoint: string;
  model: string;
  keyMode: "env" | "inline" | "none";
  keyEnv?: string;
  keyInline?: string;
}

/** Turn wizard answers into the ModelSettings stored in a profile. */
export function buildSettingsFromAnswers(a: ProfileAnswers): ModelSettings {
  const s: ModelSettings = { endpoint: a.endpoint.trim(), model: a.model.trim() };
  if (a.keyMode === "env" && a.keyEnv?.trim()) s.apiKeyEnv = a.keyEnv.trim();
  if (a.keyMode === "inline" && a.keyInline?.trim()) s.apiKey = a.keyInline.trim();
  return s;
}

export function upsertProfile(cfg: PersonaxisConfig, name: string, settings: ModelSettings): PersonaxisConfig {
  return { ...cfg, profiles: { ...cfg.profiles, [name]: settings } };
}

export function setDefaultProfile(cfg: PersonaxisConfig, name: string): PersonaxisConfig {
  return { ...cfg, defaultProfile: name };
}

export function assignProfileToPersona(cfg: PersonaxisConfig, slug: string, name: string): PersonaxisConfig {
  return { ...cfg, personas: { ...cfg.personas, [slug]: { ...cfg.personas?.[slug], profile: name } } };
}

/** Remove a profile and clean up dangling references (defaultProfile + persona.profile). */
export function removeProfile(cfg: PersonaxisConfig, name: string): PersonaxisConfig {
  const profiles = { ...cfg.profiles };
  delete profiles[name];
  const personas = Object.fromEntries(
    Object.entries(cfg.personas ?? {}).map(([slug, p]) => {
      if (p.profile === name) {
        const { profile: _dropped, ...rest } = p;
        return [slug, rest];
      }
      return [slug, p];
    }),
  );
  return {
    ...cfg,
    profiles,
    defaultProfile: cfg.defaultProfile === name ? undefined : cfg.defaultProfile,
    personas,
  };
}

export function profileNames(cfg: PersonaxisConfig): string[] {
  return Object.keys(cfg.profiles ?? {});
}

// ── Interactive flows (readline) ─────────────────────────────────────────────

type Out = (s: string) => void;
const defaultOut: Out = (s) => stdout.write(s + "\n");

async function ask(rl: ReadlineInterface, question: string, fallback = ""): Promise<string> {
  const hint = fallback ? chalk.dim(` [${fallback}]`) : "";
  const answer = (await rl.question(`${question}${hint} `)).trim();
  return answer || fallback;
}

function isYes(s: string): boolean {
  const v = s.trim().toLowerCase();
  return v === "" || v === "y" || v === "yes";
}

/**
 * Walk a user through defining ONE model profile, save it, and optionally make it the default.
 * Returns the saved profile name (or undefined if the user left it empty).
 */
export async function runModelSetup(
  rl: ReadlineInterface,
  opts: { scope?: ConfigScope; out?: Out } = {},
): Promise<{ name?: string; keyEnv?: string }> {
  const out = opts.out ?? defaultOut;
  const scope: ConfigScope = opts.scope ?? "global";
  const where = scope === "global" ? "~/.personaxis" : ".personaxis";
  out(chalk.bold("\n  Configure a model") + chalk.dim(`  (saved in ${where}/config.json, reused everywhere)`));

  const kindRaw = await ask(rl, "  Runs  [1] locally (Ollama / LM Studio)  [2] in the cloud (OpenAI-compatible)?", "1");
  const kind: "local" | "cloud" = kindRaw === "2" ? "cloud" : "local";

  const endpoint = await ask(rl, "  Endpoint URL", kind === "local" ? "http://localhost:11434/v1" : "https://api.openai.com/v1");
  const model = await ask(rl, "  Model name", kind === "local" ? "llama3.1" : "gpt-4o-mini");

  let keyMode: ProfileAnswers["keyMode"] = "none";
  let keyEnv: string | undefined;
  let keyInline: string | undefined;
  if (kind === "cloud") {
    const km = await ask(rl, "  API key via  [1] env var (recommended)  [2] paste inline  [3] none?", "1");
    if (km === "2") {
      keyMode = "inline";
      keyInline = (await rl.question("  Paste the API key: ")).trim();
    } else if (km === "3") {
      keyMode = "none";
    } else {
      keyMode = "env";
      keyEnv = await ask(rl, "  Name of the env var holding the key", "OPENAI_API_KEY");
    }
  }

  const settings = buildSettingsFromAnswers({ kind, endpoint, model, keyMode, keyEnv, keyInline });
  const suggested = kind === "local" ? "local" : model || "cloud";
  const name = await ask(rl, "  Name this profile", suggested);
  if (!name) {
    out(chalk.yellow("  no name given, nothing saved."));
    return {};
  }

  let cfg = loadConfig(scope);
  cfg = upsertProfile(cfg, name, settings);
  if (isYes(await ask(rl, `  Use "${name}" as the default model?`, "Y"))) cfg = setDefaultProfile(cfg, name);
  saveConfig(cfg, scope);

  out(chalk.green(`  ✓ saved profile "${name}"`) + chalk.dim(`  (${configPath(scope)})`));
  if (keyMode === "env") out(chalk.dim(`  ! put your key in the env var: export ${keyEnv}=...   (never stored in a file)`));
  if (keyMode === "inline") out(chalk.dim("  ! inline key stored user-only (0600); prefer an env var next time."));
  return { name, keyEnv };
}

/** List the profiles of a scope with a marker on the default; returns the ordered names. */
function showProfiles(cfg: PersonaxisConfig, out: Out): string[] {
  const names = profileNames(cfg);
  if (names.length === 0) {
    out(chalk.dim("  (no profiles yet)"));
    return [];
  }
  names.forEach((n, i) => {
    const p = cfg.profiles?.[n];
    const mark = cfg.defaultProfile === n ? chalk.green(" (default)") : "";
    out(`    ${i + 1}. ${chalk.bold(n)}${mark}  ${chalk.dim(`${p?.model ?? "?"} @ ${p?.endpoint ?? "?"}`)}`);
  });
  return names;
}

/**
 * The interactive config menu: add/edit profiles, set the default, assign a profile to a persona,
 * show the resolved config. Operates on the GLOBAL config (reused across projects).
 */
export async function runConfigMenu(
  rl: ReadlineInterface,
  opts: { cwd: string; personas?: string[]; out?: Out } = { cwd: process.cwd() },
): Promise<void> {
  const out = opts.out ?? defaultOut;
  const scope: ConfigScope = "global";

  for (;;) {
    const cfg = loadConfig(scope);
    out(chalk.bold("\n  Model config") + chalk.dim(`  resolved: ${describeModel({ cwd: opts.cwd })}`));
    showProfiles(cfg, out);
    const choice = await ask(
      rl,
      "\n  [1] add/edit a profile  [2] set default  [3] assign to a persona  [4] show all  [5] done",
      "5",
    );

    if (choice === "1") {
      await runModelSetup(rl, { scope, out });
    } else if (choice === "2") {
      const names = showProfiles(cfg, out);
      if (names.length === 0) continue;
      const pick = await ask(rl, "  Number of the profile to make default", "1");
      const name = names[Number(pick) - 1];
      if (name) {
        saveConfig(setDefaultProfile(cfg, name), scope);
        out(chalk.green(`  ✓ default = ${name}`));
      } else out(chalk.yellow("  invalid choice."));
    } else if (choice === "3") {
      const names = profileNames(cfg);
      if (names.length === 0) {
        out(chalk.yellow("  add a profile first (option 1)."));
        continue;
      }
      const personas = opts.personas ?? [];
      if (personas.length === 0) {
        out(chalk.dim("  no sub-personas here; the default profile applies to the root persona."));
        continue;
      }
      personas.forEach((s, i) => out(`    ${i + 1}. ${s}`));
      const pIdx = await ask(rl, "  Number of the persona", "1");
      const slug = personas[Number(pIdx) - 1];
      showProfiles(cfg, out);
      const prIdx = await ask(rl, "  Number of the profile to assign", "1");
      const name = names[Number(prIdx) - 1];
      if (slug && name) {
        saveConfig(assignProfileToPersona(cfg, slug, name), scope);
        out(chalk.green(`  ✓ ${slug} → ${name}`));
      } else out(chalk.yellow("  invalid choice."));
    } else if (choice === "4") {
      out(chalk.dim(`  global   ${configPath("global")}`));
      out(chalk.dim(`  project  ${configPath("project")}`));
      out(chalk.dim("  precedence: env > project > global; a persona's profile/inline beats the default."));
    } else {
      return;
    }
  }
}
