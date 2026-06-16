import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import type { ProviderName } from "./providers/types.js";

const CONFIG_PATH = resolve(process.cwd(), ".personaxis", "config.json");

export interface PersonaxisConfig {
  /** Default provider for compile/decompile. Defaults to "agent" if unset. */
  provider?: ProviderName;
  local?: {
    /** OpenAI-compatible chat-completions endpoint, e.g. http://localhost:11434/v1 */
    endpoint?: string;
    model?: string;
  };
  byok?: {
    /** Which API the key in ANTHROPIC_API_KEY / OPENAI_API_KEY belongs to. */
    apiProvider?: "anthropic" | "openai";
    model?: string;
  };
  remote?: {
    apiBase?: string;
    model?: string;
  };
}

export function loadConfig(): PersonaxisConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as PersonaxisConfig;
  } catch {
    return {};
  }
}

export function saveConfig(config: PersonaxisConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function configPath(): string {
  return CONFIG_PATH;
}
