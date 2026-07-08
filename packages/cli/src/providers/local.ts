import { resolveModel, portableJsonSchema } from "@personaxis/core";
import type { Provider, ProviderRunResult, ProviderStructuredResult } from "./types.js";
import type { PersonaxisConfig } from "../config.js";
import { postJson } from "./http.js";

const DEFAULT_ENDPOINT = "http://localhost:11434/v1";
const DEFAULT_MODEL = "llama3.1";

/**
 * Calls any OpenAI-compatible chat-completions endpoint — local (Ollama, llama.cpp,
 * LM Studio) OR a hosted, authenticated one (Cohere/OpenRouter/Groq/...). Configure with:
 *
 *   personaxis config set provider local
 *   personaxis config set local.endpoint http://localhost:11434/v1
 *   personaxis config set local.model llama3.1
 *
 * Model resolution is the SAME layered config the living loop uses (`resolveModel`:
 * env > project > global, key via `apiKeyEnv`), so `personaxis config set --global local.*` drives
 * compile too — not just the REPL. Falls back to the passed project config, then localhost defaults.
 */
export function createLocalProvider(config: PersonaxisConfig): Provider {
  const resolved = resolveModel({ cwd: process.cwd() });
  const endpoint = resolved?.endpoint ?? config.local?.endpoint ?? DEFAULT_ENDPOINT;
  const model = resolved?.model ?? config.local?.model ?? DEFAULT_MODEL;
  const apiKey = resolved?.apiKey ?? config.local?.apiKey;

  const url = `${endpoint.replace(/\/$/, "")}/chat/completions`;
  const headers: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};

  const call = async (body: Record<string, unknown>): Promise<{ text: string; model: string }> => {
    let json: { model?: string; choices?: { message?: { content?: string } }[] };
    try {
      json = (await postJson(url, headers, { model, temperature: 0.2, ...body })) as typeof json;
    } catch (e) {
      throw new Error(
        `Local provider request failed: ${(e as Error).message}\n` +
          `Is your local model server running? Configure the endpoint with ` +
          `"personaxis config set local.endpoint <url>".`,
      );
    }
    const text = json.choices?.[0]?.message?.content;
    if (!text) throw new Error(`Local provider at ${endpoint} returned no content.`);
    return { text, model: json.model ?? model };
  };

  return {
    name: "local",
    source: "cli-local",
    async run(prompt: string): Promise<ProviderRunResult> {
      const r = await call({ messages: [{ role: "user", content: prompt }] });
      return { ...r, source: "cli-local" };
    },
    /** Structured output with graceful degradation: json_schema (llama.cpp,
     *  LM Studio, vLLM, hosted OpenAI-compatibles) → json_object (Ollama and
     *  older servers) → plain text + parse. The caller's validator is the
     *  final gate either way. */
    async runStructured(prompt: string, schema: unknown, name: string): Promise<ProviderStructuredResult> {
      const messages = [{ role: "user", content: prompt }];
      const attempts: Array<Record<string, unknown>> = [
        { messages, response_format: { type: "json_schema", json_schema: { name, schema: portableJsonSchema(schema), strict: false } } },
        { messages, response_format: { type: "json_object" } },
        { messages },
      ];
      let lastErr: Error | undefined;
      for (const body of attempts) {
        try {
          const r = await call(body);
          // Some servers wrap JSON in a code fence even under response_format.
          const raw = r.text.trim().replace(/^```[a-zA-Z]*\s*\n?|\n?```$/g, "");
          return { json: JSON.parse(raw) as unknown, model: r.model, source: "cli-local" };
        } catch (e) {
          lastErr = e as Error;
        }
      }
      throw new Error(`Local provider structured call failed after all fallbacks: ${lastErr?.message}`);
    },
  };
}
