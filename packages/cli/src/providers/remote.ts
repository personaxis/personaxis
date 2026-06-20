import type { Provider, ProviderRunResult } from "./types.js";
import type { PersonaxisConfig } from "../config.js";

const DEFAULT_API_BASE = "https://api.personaxis.com";

/**
 * Calls Personaxis-hosted models (paid plan). Configure with:
 *
 *   personaxis config set provider remote
 *   personaxis config set remote.apiBase https://api.personaxis.com
 *
 * Auth token is read from PERSONAXIS_API_TOKEN and is never written to
 * .personaxis/config.json.
 */
export function createRemoteProvider(config: PersonaxisConfig): Provider {
  const apiBase = config.remote?.apiBase ?? DEFAULT_API_BASE;
  const model = config.remote?.model;

  return {
    name: "remote",
    source: "cli-remote",
    async run(prompt: string): Promise<ProviderRunResult> {
      const token = process.env.PERSONAXIS_API_TOKEN;
      if (!token) {
        throw new Error(
          `The "remote" provider requires PERSONAXIS_API_TOKEN to be set.\n` +
            `Sign in at https://personaxis.com to get a token, then export it in your shell.`,
        );
      }

      const res = await fetch(`${apiBase.replace(/\/$/, "")}/api/v1/spec/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ prompt, model }),
      });

      if (!res.ok) {
        throw new Error(`Remote provider request to ${apiBase} failed: ${res.status} ${res.statusText}`);
      }

      const json = (await res.json()) as { text?: string; model?: string };
      if (!json.text) throw new Error(`Remote provider at ${apiBase} returned no text content.`);

      return { text: json.text, model: json.model ?? model ?? "personaxis-hosted", source: "cli-remote" };
    },
  };
}
