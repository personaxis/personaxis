import type { Provider, ProviderRunResult } from "./types.js";
import type { PersonaxisConfig } from "../config.js";

const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
const DEFAULT_OPENAI_MODEL = "gpt-4.1";

async function runAnthropic(prompt: string, model: string): Promise<ProviderRunResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      `BYOK provider is configured for Anthropic but ANTHROPIC_API_KEY is not set.\n` +
        `Export it in your shell - personaxis never stores API keys in .personaxis/config.json.`,
    );
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic API request failed: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as { content?: { type: string; text?: string }[]; model?: string };
  const text = json.content?.find((block) => block.type === "text")?.text;
  if (!text) throw new Error("Anthropic API returned no text content.");

  return { text, model: json.model ?? model, source: "cli-byok" };
}

async function runOpenAI(prompt: string, model: string): Promise<ProviderRunResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      `BYOK provider is configured for OpenAI but OPENAI_API_KEY is not set.\n` +
        `Export it in your shell - personaxis never stores API keys in .personaxis/config.json.`,
    );
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenAI API request failed: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as { model?: string; choices?: { message?: { content?: string } }[] };
  const text = json.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenAI API returned no content.");

  return { text, model: json.model ?? model, source: "cli-byok" };
}

/**
 * Calls the user's own Anthropic or OpenAI account. Configure with:
 *
 *   personaxis config set provider byok
 *   personaxis config set byok.apiProvider anthropic   # or openai
 *   personaxis config set byok.model claude-sonnet-4-6
 *
 * API keys are read from ANTHROPIC_API_KEY / OPENAI_API_KEY and are never
 * written to .personaxis/config.json.
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
  };
}
