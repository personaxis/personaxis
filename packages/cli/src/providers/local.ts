import { resolveModel, portableJsonSchema, isLocalEndpoint } from "@personaxis/core";
import type { Provider, ProviderRunResult, ProviderStructuredResult } from "./types.js";
import type { PersonaxisConfig } from "../config.js";
import { postJson } from "./http.js";

const DEFAULT_ENDPOINT = "http://localhost:11434/v1";
const DEFAULT_MODEL = "llama3.1";

/**
 * How long a completion of this size can honestly take, with a floor and a ceiling.
 *
 * Derived rather than picked: a small open model on a shared router generates at roughly
 * 25 tokens per second (measured 2026-09-10, gemma-3-4b-it at 24 to 28 t/s), and the floor
 * of 15 leaves room for a slower model or a busy hour without turning every long answer
 * into a timeout. The ceiling keeps a hung endpoint from holding the CLI for ten minutes.
 */
const FLOOR_TOKENS_PER_SECOND = 15;
export function timeoutFor(maxTokens: number): number {
  const needed = (maxTokens / FLOOR_TOKENS_PER_SECOND) * 1000;
  return Math.min(600_000, Math.max(120_000, Math.round(needed)));
}

/**
 * How big a completion this endpoint can actually finish, which is not the same question as
 * how big a completion we would like.
 *
 * A server on this machine answers to us and nobody else, so the budget is ours to set. A
 * HOSTED router sits behind a gateway with its own patience, and that patience is the real
 * ceiling: measured 2026-09-10 on the HuggingFace router with gemma-3-4b-it, a 4096-token
 * request finished in 87 seconds, and an 8192-token one came back **504 Gateway Time-out**
 * with the model still working. Asking a hosted endpoint for more than its gateway will wait
 * for does not get a longer answer, it gets no answer.
 *
 * Streaming is the real fix for long hosted generations, and since E48 (2026-10-03) the calls
 * below are streamed. The budget stays where it was until the streamed call has been measured
 * against that same router, which has had no credits since 2026-09-25: NVIDIA's API, the
 * hosted endpoint at hand, does not cut a whole 8192-token answer (5,383 tokens in 35 s), so
 * it cannot show the gateway's limit either way.
 */
export function budgetFor(endpoint: string, configured?: number): number {
  if (configured !== undefined) return configured;
  return isLocalEndpoint(endpoint) ? 8192 : 4096;
}

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
      const maxTokens = budgetFor(endpoint, resolved?.maxTokens ?? config.local?.maxTokens);
      json = (await postJson(
        url,
        headers,
        // E48: streamed, so a hosted gateway sees the answer start instead of a long silence. Measured 2026-09-10 on
        // the HuggingFace router: a whole 8192-token completion came back 504 with the model still working.
        { model, temperature: 0.2, max_tokens: maxTokens, stream: true, ...body },
        // The clock has to fit the budget, or the two disagree and the budget always loses.
        // Measured 2026-09-10: gemma-3-4b-it sustains 24 to 28 tokens/second on the
        // HuggingFace router, so 8192 tokens is about five and a half minutes. A 120-second
        // default covered roughly 3000 of the 8192 the provider now asks for, which is how a
        // persona polish died on the clock while the budget was never the problem.
        { timeoutMs: timeoutFor(maxTokens) },
      )) as typeof json;
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
