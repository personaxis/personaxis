/**
 * The interactive model-configuration UI, rendered as a real TUI (Ink cards, arrow-navigable, one
 * description per option) instead of plain readline. Orchestrates the generic `tui` prompt kit with
 * the pure, unit-tested builders in `config-wizard.ts`; this file holds only the flow (which prompt
 * follows which), so the logic stays testable without a TTY.
 *
 * Used by the `personaxis config` subcommand (which the REPL's /config launches as a subprocess) and
 * by first-run onboarding. A readline fallback (config-wizard.ts) still serves PERSONAXIS_NO_INK and
 * non-TTY callers.
 */

import { selectCards, promptText, type Card } from "@personaxis/tui/prompt";
import { describeModel } from "@personaxis/core";
import { loadConfig, saveConfig, configPath, type ConfigScope, type PersonaxisConfig } from "./config.js";
import {
  buildProfileFromAnswers,
  upsertProfile,
  setDefaultProfile,
  assignProfileToPersona,
  profileNames,
  type ProfileAnswers,
  type ProviderKind,
} from "./config-wizard.js";

const PROVIDER_CARDS: Card[] = [
  { value: "local", title: "Local / OpenAI-compatible", desc: "Ollama, LM Studio, or any OpenAI-compatible URL. No key." },
  { value: "openai", title: "OpenAI", desc: "Your OpenAI account. Uses OPENAI_API_KEY." },
  { value: "anthropic", title: "Anthropic", desc: "Your Claude account. Reasons live + compiles." },
  { value: "huggingface", title: "HuggingFace", desc: "Inference router. Uses HF_TOKEN." },
  { value: "cohere", title: "Cohere", desc: "Cohere's compatibility API. Uses COHERE_API_KEY." },
  { value: "remote", title: "Personaxis hosted", desc: "Our managed models (paid)." },
  { value: "agent", title: "Coding agent", desc: "No key; hands prompts to Claude Code / Codex." },
];

/** A one-card "message + enter to continue" pause, so the UI can report and wait. */
async function notice(message: string): Promise<void> {
  await selectCards(message, [{ value: "ok", title: "OK ↵" }], "enter to continue");
}

/** Profiles as selectable cards, with the default marked. */
function profileCards(cfg: PersonaxisConfig): Card[] {
  return profileNames(cfg).map((n) => {
    const p = cfg.profiles?.[n];
    const prov = p?.provider ?? "local";
    const where = p?.endpoint ?? p?.apiBase ?? p?.apiProvider ?? "";
    const mark = cfg.defaultProfile === n ? " (default)" : "";
    return { value: n, title: n + mark, desc: `${prov} · ${p?.model ?? "(server default)"}${where ? ` @ ${where}` : ""}` };
  });
}

/** Walk the user through defining ONE profile (Ink), save it, optionally make it the default. */
export async function runModelSetupInk(scope: ConfigScope = "global"): Promise<{ name?: string; keyEnv?: string }> {
  const kind = (await selectCards("◉ personaxis · configure model · choose a provider", PROVIDER_CARDS)) as ProviderKind | null;
  if (!kind) return {};

  const answers: ProfileAnswers = { kind };
  let keyEnv: string | undefined;
  if (kind === "local") {
    answers.endpoint = await promptText("Endpoint URL (blank = the default shown, an Ollama server)", "http://localhost:11434/v1");
    answers.model = await promptText("Model name", "llama3.1");
    const km = await selectCards("How should personaxis get the API key?", [
      { value: "none", title: "No key", desc: "a local server with no auth (Ollama, LM Studio)" },
      { value: "inline", title: "Paste it now", desc: "you paste the key; it is saved in your private ~/.personaxis/config.json (user-only)" },
      { value: "env", title: "From an environment variable", desc: "you set e.g. COHERE_API_KEY in your shell; the key is never written to a file (best for repos, CI, prod)" },
    ]);
    if (km === "env") {
      answers.keyMode = "env";
      answers.keyEnv = keyEnv = await promptText("Name of the env var that holds your key", "COHERE_API_KEY");
    } else if (km === "inline") {
      answers.keyMode = "inline";
      answers.keyInline = await promptText("Paste your API key");
    } else {
      answers.keyMode = "none";
    }
  } else if (kind === "cohere") {
    answers.model = await promptText("Model name", "command-r-plus");
    answers.keyEnv = keyEnv = await promptText("Env var holding your Cohere key", "COHERE_API_KEY");
  } else if (kind === "openai") {
    answers.model = await promptText("Model name", "gpt-4o-mini");
    answers.keyEnv = keyEnv = await promptText("Env var holding your OpenAI key", "OPENAI_API_KEY");
  } else if (kind === "anthropic") {
    answers.model = await promptText("Model name", "claude-sonnet-4-6");
    answers.keyEnv = keyEnv = await promptText("Env var holding your Anthropic key", "ANTHROPIC_API_KEY");
  } else if (kind === "huggingface") {
    answers.model = await promptText("Model id (e.g. meta-llama/Llama-3.1-8B-Instruct)", "meta-llama/Llama-3.1-8B-Instruct");
    answers.keyEnv = keyEnv = await promptText("Env var holding your HF token", "HF_TOKEN");
  } else if (kind === "remote") {
    answers.apiBase = await promptText("Personaxis API base", "https://api.personaxis.com");
    answers.model = await promptText("Model (optional, blank for the server default)", "");
    keyEnv = "PERSONAXIS_API_TOKEN";
  }

  const profile = buildProfileFromAnswers(answers);
  const suggested = kind === "remote" ? "personaxis" : kind;
  const name = await promptText("Name this profile", suggested);
  if (!name) return {};

  let cfg = loadConfig(scope);
  cfg = upsertProfile(cfg, name, profile);
  const mk = await selectCards(`Use "${name}" as the default model?`, [
    { value: "yes", title: "Yes, make it the default" },
    { value: "no", title: "No, just save it" },
  ]);
  if (mk !== "no") cfg = setDefaultProfile(cfg, name);
  saveConfig(cfg, scope);

  const lines = [`✓ saved "${name}" (${profile.provider}, ${configPath(scope)})`];
  if (keyEnv) lines.push(`Put your key in the env var:  export ${keyEnv}=...   (never stored in a file)`);
  await notice(lines.join("\n"));
  return { name, keyEnv };
}

/** The interactive config menu (Ink): add/edit profiles, set the default, assign to a persona, show. */
export async function runConfigMenuInk(opts: { cwd: string; personas?: string[] }): Promise<void> {
  for (;;) {
    const cfg = loadConfig("global");
    const menu: Card[] = [
      { value: "add", title: "Add / edit a model", desc: "define a new profile (any provider)" },
      { value: "default", title: "Set the default model", desc: `active: ${describeModel({ cwd: opts.cwd })}` },
      { value: "assign", title: "Assign a model to a persona", desc: "a per-persona override" },
      { value: "show", title: "Show config", desc: "profiles and where they live" },
      { value: "done", title: "Done", desc: "back to the app" },
    ];
    const choice = await selectCards("◉ personaxis · model config", menu);
    if (!choice || choice === "done") return;

    if (choice === "add") {
      await runModelSetupInk("global");
    } else if (choice === "default") {
      const cards = profileCards(cfg);
      if (!cards.length) {
        await notice("No profiles yet. Choose 'Add / edit a model' first.");
        continue;
      }
      const pick = await selectCards("Set the default model", cards);
      if (pick) saveConfig(setDefaultProfile(cfg, pick), "global");
    } else if (choice === "assign") {
      const cards = profileCards(cfg);
      const personas = opts.personas ?? [];
      if (!cards.length) {
        await notice("Add a profile first.");
        continue;
      }
      if (!personas.length) {
        await notice("No sub-personas here; the default profile applies to the root persona.");
        continue;
      }
      const slug = await selectCards("Which persona?", personas.map((s) => ({ value: s, title: s })));
      if (!slug) continue;
      const prof = await selectCards(`Assign a model to ${slug}`, cards);
      if (prof) saveConfig(assignProfileToPersona(cfg, slug, prof), "global");
    } else if (choice === "show") {
      const g = profileNames(cfg);
      const body = [
        `global   ${configPath("global")}`,
        `project  ${configPath("project")}`,
        "",
        g.length ? `profiles: ${g.join(", ")}` : "no profiles yet",
        `default:  ${cfg.defaultProfile ?? "(none)"}`,
        "",
        "precedence: env > project > global; a persona's profile beats the default.",
      ].join("\n");
      await notice(body);
    }
  }
}
