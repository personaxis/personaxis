import type { Provider, ProviderRunResult } from "./types.js";
import type { PersonaxisConfig } from "../config.js";

const DEFAULT_ENDPOINT = "http://localhost:11434/v1";
const DEFAULT_MODEL = "llama3.1";

/**
 * Calls a local OpenAI-compatible chat-completions endpoint (Ollama,
 * llama.cpp server, LM Studio, ...). Configure with:
 *
 *   personaxis config set provider local
 *   personaxis config set local.endpoint http://localhost:11434/v1
 *   personaxis config set local.model llama3.1
 */
export function createLocalProvider(config: PersonaxisConfig): Provider {
  const endpoint = config.local?.endpoint ?? DEFAULT_ENDPOINT;
  const model = config.local?.model ?? DEFAULT_MODEL;

  return {
    name: "local",
    source: "cli-local",
    async run(prompt: string): Promise<ProviderRunResult> {
      const res = await fetch(`${endpoint.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.2,
        }),
      });

      if (!res.ok) {
        throw new Error(
          `Local provider request to ${endpoint} failed: ${res.status} ${res.statusText}\n` +
            `Is your local model server running? Configure the endpoint with ` +
            `"personaxis config set local.endpoint <url>".`,
        );
      }

      const json = (await res.json()) as {
        model?: string;
        choices?: { message?: { content?: string } }[];
      };
      const text = json.choices?.[0]?.message?.content;
      if (!text) {
        throw new Error(`Local provider at ${endpoint} returned no content.`);
      }

      return { text, model: json.model ?? model, source: "cli-local" };
    },
  };
}
