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
import { describeModel } from "@personaxis/core";
import { loadConfig, saveConfig, configPath, type ConfigScope, type PersonaxisConfig, type ModelProfile } from "./config.js";

// ── Pure builders (no IO, unit-tested) ───────────────────────────────────────

/** What the user picks in the wizard; maps to a provider + its fields. */
export type ProviderKind = "local" | "openai" | "anthropic" | "huggingface" | "remote" | "agent";

export interface ProfileAnswers {
  kind: ProviderKind;
  endpoint?: string;
  model?: string;
  apiBase?: string;
  keyMode?: "env" | "inline" | "none";
  keyEnv?: string;
  keyInline?: string;
}

const trimmed = (s?: string): string | undefined => (s?.trim() ? s.trim() : undefined);

/**
 * Turn wizard answers into a full ModelProfile (provider + the fields that provider needs). Every
 * cloud preset also stores an OpenAI-compatible `endpoint`, so the SAME profile drives both compile
 * and the live REPL reasoning: OpenAI, HuggingFace (its OpenAI-compatible router), and Anthropic (its
 * OpenAI-compatibility endpoint) all reason live.
 */
export function buildProfileFromAnswers(a: ProfileAnswers): ModelProfile {
  switch (a.kind) {
    case "openai":
      return { provider: "byok", apiProvider: "openai", model: trimmed(a.model), endpoint: "https://api.openai.com/v1", apiKeyEnv: trimmed(a.keyEnv) ?? "OPENAI_API_KEY" };
    case "anthropic":
      // byok drives compile (native forced-tool structured output); the endpoint is Anthropic's
      // OpenAI-compatibility base, so the live REPL reasons with the same key/model too.
      return { provider: "byok", apiProvider: "anthropic", model: trimmed(a.model), endpoint: "https://api.anthropic.com/v1", apiKeyEnv: trimmed(a.keyEnv) ?? "ANTHROPIC_API_KEY" };
    case "huggingface":
      // HuggingFace's Inference Providers router is OpenAI-compatible, so a plain local provider
      // pointed at it serves both compile and the live REPL.
      return { provider: "local", endpoint: "https://router.huggingface.co/v1", model: trimmed(a.model), apiKeyEnv: trimmed(a.keyEnv) ?? "HF_TOKEN" };
    case "remote":
      return { provider: "remote", apiBase: trimmed(a.apiBase) ?? "https://api.personaxis.com", ...(trimmed(a.model) ? { model: trimmed(a.model) } : {}) };
    case "agent":
      return { provider: "agent" };
    case "local":
    default: {
      const p: ModelProfile = { provider: "local", endpoint: trimmed(a.endpoint), model: trimmed(a.model) };
      if (a.keyMode === "env" && trimmed(a.keyEnv)) p.apiKeyEnv = trimmed(a.keyEnv);
      if (a.keyMode === "inline" && trimmed(a.keyInline)) p.apiKey = trimmed(a.keyInline);
      return p;
    }
  }
}

export function upsertProfile(cfg: PersonaxisConfig, name: string, profile: ModelProfile): PersonaxisConfig {
  return { ...cfg, profiles: { ...cfg.profiles, [name]: profile } };
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
  out(chalk.dim("  Provider:"));
  out(chalk.dim("    [1] Local / OpenAI-compatible (Ollama, LM Studio, any OpenAI-compatible URL)"));
  out(chalk.dim("    [2] OpenAI (your OpenAI key)"));
  out(chalk.dim("    [3] Anthropic (your Anthropic key)"));
  out(chalk.dim("    [4] HuggingFace (your HF token)"));
  out(chalk.dim("    [5] Personaxis hosted (remote)"));
  out(chalk.dim("    [6] Coding agent (no key; hands off to Claude Code / Codex)"));
  const provRaw = await ask(rl, "  Choose", "1");
  const kind: ProviderKind =
    provRaw === "2" ? "openai"
      : provRaw === "3" ? "anthropic"
      : provRaw === "4" ? "huggingface"
      : provRaw === "5" ? "remote"
      : provRaw === "6" ? "agent"
      : "local";

  const answers: ProfileAnswers = { kind };
  let keyEnv: string | undefined;
  if (kind === "local") {
    answers.endpoint = await ask(rl, "  Endpoint URL", "http://localhost:11434/v1");
    answers.model = await ask(rl, "  Model name", "llama3.1");
    const km = await ask(rl, "  API key via  [1] env var  [2] paste inline  [3] none?", "3");
    if (km === "1") {
      answers.keyMode = "env";
      answers.keyEnv = keyEnv = await ask(rl, "  Name of the env var holding the key", "OPENAI_API_KEY");
    } else if (km === "2") {
      answers.keyMode = "inline";
      answers.keyInline = (await rl.question("  Paste the API key: ")).trim();
    } else {
      answers.keyMode = "none";
    }
  } else if (kind === "openai") {
    answers.model = await ask(rl, "  Model name", "gpt-4o-mini");
    answers.keyEnv = keyEnv = await ask(rl, "  Env var holding your OpenAI key", "OPENAI_API_KEY");
  } else if (kind === "anthropic") {
    answers.model = await ask(rl, "  Model name", "claude-sonnet-4-6");
    answers.keyEnv = keyEnv = await ask(rl, "  Env var holding your Anthropic key", "ANTHROPIC_API_KEY");
  } else if (kind === "huggingface") {
    answers.model = await ask(rl, "  Model id (e.g. meta-llama/Llama-3.1-8B-Instruct)", "meta-llama/Llama-3.1-8B-Instruct");
    answers.keyEnv = keyEnv = await ask(rl, "  Env var holding your HF token", "HF_TOKEN");
  } else if (kind === "remote") {
    answers.apiBase = await ask(rl, "  Personaxis API base", "https://api.personaxis.com");
    answers.model = await ask(rl, "  Model (optional, blank for the server default)", "");
    keyEnv = "PERSONAXIS_API_TOKEN";
  }

  const profile = buildProfileFromAnswers(answers);
  const suggested = kind === "remote" ? "personaxis" : kind;
  const name = await ask(rl, "  Name this profile", suggested);
  if (!name) {
    out(chalk.yellow("  no name given, nothing saved."));
    return {};
  }

  let cfg = loadConfig(scope);
  cfg = upsertProfile(cfg, name, profile);
  if (isYes(await ask(rl, `  Use "${name}" as the default model?`, "Y"))) cfg = setDefaultProfile(cfg, name);
  saveConfig(cfg, scope);

  out(chalk.green(`  ✓ saved profile "${name}"`) + chalk.dim(`  (${profile.provider}, ${configPath(scope)})`));
  if (keyEnv) out(chalk.dim(`  ! put your key in the env var: export ${keyEnv}=...   (never stored in a file)`));
  if (answers.keyMode === "inline") out(chalk.dim("  ! inline key stored user-only (0600); prefer an env var next time."));
  if (kind === "remote") out(chalk.dim("  note: the Personaxis-hosted provider drives compile; live REPL reasoning needs an OpenAI-compatible endpoint."));
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
    const prov = p?.provider ?? "local";
    const where = p?.endpoint ?? p?.apiBase ?? (prov === "byok" ? p?.apiProvider : undefined);
    const mark = cfg.defaultProfile === n ? chalk.green(" (default)") : "";
    out(`    ${i + 1}. ${chalk.bold(n)}${mark}  ${chalk.dim(`${prov} · ${p?.model ?? "(server default)"}${where ? ` @ ${where}` : ""}`)}`);
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
