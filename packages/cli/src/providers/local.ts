import { resolveModel, portableJsonSchema } from "@personaxis/core";
import type { Provider, ProviderRunResult, ProviderStructuredResult } from "./types.js";
import type { PersonaxisConfig } from "../config.js";
import { postJson } from "./http.js";

const DEFAULT_ENDPOINT = "http://localhost:11434/v1";
const DEFAULT_MODEL = "llama3.1";

/**
 * Whether an error means "the endpoint is not reachable" rather than "the endpoint does not
 * support this request shape". Only the second kind is worth retrying with a simpler body.
 */
function isUnreachable(e: Error): boolean {
  const cause = (e as { cause?: { code?: string } }).cause?.code ?? "";
  return /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up|network/i.test(
    `${e.message} ${cause}`,
  );
}

/**
 * Calls any OpenAI-compatible chat-completions endpoint, local (Ollama, llama.cpp,
 * LM Studio) OR a hosted, authenticated one (Cohere/OpenRouter/Groq/...). Configure with:
 *
 *   personaxis config set provider local
 *   personaxis config set local.endpoint http://localhost:11434/v1
 *   personaxis config set local.model llama3.1
 *
 * Model resolution is the SAME layered config the living loop uses (`resolveModel`:
 * env > project > global, key via `apiKeyEnv`), so `personaxis config set --global local.*` drives
 * compile too, not just the REPL. Falls back to the passed project config, then localhost defaults.
 */
export function createLocalProvider(config: PersonaxisConfig, personaPath?: string): Provider {
  const resolved = resolveModel({ cwd: process.cwd(), ...(personaPath ? { personaPath } : {}) });
  const endpoint = resolved?.endpoint ?? config.local?.endpoint ?? DEFAULT_ENDPOINT;
  const model = resolved?.model ?? config.local?.model ?? DEFAULT_MODEL;
  const apiKey = resolved?.apiKey ?? config.local?.apiKey;

  const url = `${endpoint.replace(/\/$/, "")}/chat/completions`;
  const headers: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};

  const call = async (body: Record<string, unknown>): Promise<{ text: string; model: string }> => {
    let json: {
      model?: string;
      choices?: { finish_reason?: string; message?: { content?: string; reasoning?: string; reasoning_content?: string } }[];
    };
    try {
      // An EXPLICIT budget, because the server's implicit one is not survivable by a model
      // that thinks before it answers. Measured 2026-09-10 on the HuggingFace router with
      // Qwen3.5-9B: with a `response_format` set and no max_tokens the server caps the
      // completion at 2048, the model spends all 2048 thinking, and returns HTTP 200 with an
      // EMPTY content. The same call with max_tokens 8192 answers in 2303 tokens.
      //
      // That one missing parameter is why Genesis fell back to its heuristic baseline on
      // every brief: the extractor's three response_format fallbacks each died the same way,
      // so a persona built from a rich brief came out with one default trait. 8192 matches
      // what the BYOK provider already asks for, so the two do not disagree about how much
      // room a model gets.
      json = (await postJson(url, headers, {
        model,
        temperature: 0.2,
        max_tokens: resolved?.maxTokens ?? config.local?.maxTokens ?? 8192,
        ...body,
      })) as typeof json;
    } catch (e) {
      throw new Error(
        `Local provider request failed: ${(e as Error).message}\n` +
          `Is your local model server running? Configure the endpoint with ` +
          `"personaxis config set local.endpoint <url>".`,
      );
    }
    const choice = json.choices?.[0];
    const text = choice?.message?.content;
    if (!text) {
      // The 2026 generation of open models thinks before it answers, and the thinking is
      // billed against the same completion budget. When the budget runs out mid-thought the
      // server returns HTTP 200 with an EMPTY content and `finish_reason: length`, so the
      // honest failure is "the answer never started", not "the endpoint is broken".
      //
      // Measured 2026-09-10 on the HuggingFace router with Qwen3.5-9B: a two-token answer
      // ("ok") cost 254 completion tokens of reasoning, and `usage.reasoning_tokens` reported
      // 0, so the usage block does not tell you where the budget went either. Saying this in
      // the error is the difference between a one-line config change and an afternoon.
      const reasoning = choice?.message?.reasoning ?? choice?.message?.reasoning_content;
      const why =
        choice?.finish_reason === "length"
          ? ` The model hit its token limit before writing an answer${reasoning ? ", having spent the budget thinking" : ""}.` +
            ` Raise max_tokens for this model: a reasoning model needs room for the thinking AND the answer.`
          : reasoning
            ? ` The model returned only its reasoning and no answer. Raise max_tokens, or use a model that separates the two.`
            : "";
      throw new Error(`Local provider at ${endpoint} returned no content.${why}`);
    }
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
          // These fallbacks exist for servers that do not SUPPORT a response_format, not
          // for a server that is not there. Retrying a different body against an endpoint
          // that refused the connection only multiplies the wait: creation took ~24 s to
          // report an unreachable model that was knowable on the first attempt.
          if (isUnreachable(lastErr)) break;
        }
      }
      throw new Error(`Local provider structured call failed after all fallbacks: ${lastErr?.message}`);
    },
  };
}
