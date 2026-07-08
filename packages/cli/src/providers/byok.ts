import { portableJsonSchema } from "@personaxis/core";
import type { Provider, ProviderRunResult, ProviderStructuredResult } from "./types.js";
import type { PersonaxisConfig } from "../config.js";
import { resolveCredential } from "../credentials.js";
import { postJson } from "./http.js";

const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
const DEFAULT_OPENAI_MODEL = "gpt-4.1";

function requireKey(name: "ANTHROPIC_API_KEY" | "OPENAI_API_KEY", vendor: string): string {
  const apiKey = resolveCredential(name);
  if (!apiKey) {
    throw new Error(
      `BYOK provider is configured for ${vendor} but ${name} is not set.\n` +
        `Export it in your shell or store it with \`personaxis credential set ${name}\` - ` +
        `personaxis never stores API keys in .personaxis/config.json.`,
    );
  }
  return apiKey;
}

// ── Anthropic ────────────────────────────────────────────────────────────────

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const anthropicHeaders = (apiKey: string): Record<string, string> => ({
  "x-api-key": apiKey,
  "anthropic-version": "2023-06-01",
});

async function runAnthropic(prompt: string, model: string): Promise<ProviderRunResult> {
  const apiKey = requireKey("ANTHROPIC_API_KEY", "Anthropic");
  const json = (await postJson(ANTHROPIC_URL, anthropicHeaders(apiKey), {
    model,
    max_tokens: 8192,
    messages: [{ role: "user", content: prompt }],
  })) as { content?: { type: string; text?: string }[]; model?: string };
  const text = json.content?.find((block) => block.type === "text")?.text;
  if (!text) throw new Error("Anthropic API returned no text content.");
  return { text, model: json.model ?? model, source: "cli-byok" };
}

/** Structured output via FORCED tool use — Anthropic's schema-constrained path. */
async function runAnthropicStructured(
  prompt: string,
  schema: unknown,
  name: string,
  model: string,
): Promise<ProviderStructuredResult> {
  const apiKey = requireKey("ANTHROPIC_API_KEY", "Anthropic");
  const json = (await postJson(ANTHROPIC_URL, anthropicHeaders(apiKey), {
    model,
    max_tokens: 8192,
    messages: [{ role: "user", content: prompt }],
    tools: [{ name, description: `Emit the ${name} object.`, input_schema: schema }],
    tool_choice: { type: "tool", name },
  })) as { content?: { type: string; input?: unknown }[]; model?: string };
  const tool = json.content?.find((block) => block.type === "tool_use");
  if (!tool || tool.input === undefined) throw new Error("Anthropic API returned no tool_use input.");
  return { json: tool.input, model: json.model ?? model, source: "cli-byok" };
}

// ── OpenAI ───────────────────────────────────────────────────────────────────

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

async function runOpenAI(prompt: string, model: string): Promise<ProviderRunResult> {
  const apiKey = requireKey("OPENAI_API_KEY", "OpenAI");
  const json = (await postJson(OPENAI_URL, { authorization: `Bearer ${apiKey}` }, {
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
  })) as { model?: string; choices?: { message?: { content?: string } }[] };
  const text = json.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenAI API returned no content.");
  return { text, model: json.model ?? model, source: "cli-byok" };
}

async function runOpenAIStructured(
  prompt: string,
  schema: unknown,
  name: string,
  model: string,
): Promise<ProviderStructuredResult> {
  const apiKey = requireKey("OPENAI_API_KEY", "OpenAI");
  const json = (await postJson(OPENAI_URL, { authorization: `Bearer ${apiKey}` }, {
    model,
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_schema", json_schema: { name, schema, strict: false } },
  })) as { model?: string; choices?: { message?: { content?: string } }[] };
  const text = json.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenAI API returned no content.");
  return { json: JSON.parse(text) as unknown, model: json.model ?? model, source: "cli-byok" };
}

/**
 * Calls the user's own Anthropic or OpenAI account. Configure with:
 *
 *   personaxis config set provider byok
 *   personaxis config set byok.apiProvider anthropic   # or openai
 *   personaxis config set byok.model claude-sonnet-4-6
 *
 * API keys are read from ANTHROPIC_API_KEY / OPENAI_API_KEY and are never
 * written to .personaxis/config.json. All calls go through the hardened HTTP
 * helper (timeout, 429/5xx retry with jittered backoff, body-carrying errors).
 */
export function createByokProvider(config: PersonaxisConfig): Provider {
  const apiProvider = config.byok?.apiProvider ?? "anthropic";
  const model = config.byok?.model ?? (apiProvider === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_OPENAI_MODEL);

  return {
    name: "byok",
    source: "cli-byok",
    run(prompt: string): Promise<ProviderRunResult> {
      return apiProvider === "anthropic" ? runAnthropic(prompt, model) : runOpenAI(prompt, model);
    },
    runStructured(prompt: string, schema: unknown, name: string): Promise<ProviderStructuredResult> {
      // Hosted structured-output backends accept only the structural JSON-Schema
      // subset; the engine re-imposes every dropped constraint downstream.
      const portable = portableJsonSchema(schema);
      return apiProvider === "anthropic"
        ? runAnthropicStructured(prompt, portable, name, model)
        : runOpenAIStructured(prompt, portable, name, model);
    },
  };
}
