/**
 * Context-window management (the bottom-bar meter + auto-compaction).
 *
 * Every serious agent tracks how full the model's context window is and compacts
 * before it overflows (Claude Code auto-compacts ~80%; Hermes shows `model │
 * 14.4K/256K │ %`). Two hard parts handled here, model-agnostically:
 *   1. The window VARIES per model and we won't hardcode thousands, so we resolve
 *      it dynamically from the endpoint's `/models` (OpenRouter/Ollama expose
 *      `context_length`), cache it, and fall back to a small pattern table.
 *   2. Compaction must fire with HEADROOM (default 0.8): summarizing is itself a
 *      model call that needs room for the conversation + the summary; waiting for
 *      100% leaves no space and most providers hard-error at the limit.
 */

import type { TokenUsage } from "./tool-calling.js";
import type { ChatMessage } from "./tool-calling.js";

export interface ModelEndpoint {
  endpoint: string;
  model: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

// Pattern table fallback (used when /models doesn't report a window). Conservative.
const WINDOW_TABLE: Array<[RegExp, number]> = [
  [/command-a|command-r-plus/i, 256_000],
  [/command-r|command/i, 128_000],
  [/gpt-5|gpt-4\.1|o3|o4|gpt-4o-2/i, 1_000_000],
  [/gpt-4o|gpt-4-turbo|gpt-4\b/i, 128_000],
  [/claude/i, 200_000],
  [/gemini/i, 1_000_000],
  [/deepseek/i, 128_000],
  [/qwen|llama|mistral|phi|gemma/i, 32_768],
];
const DEFAULT_WINDOW = 32_768;

const cache = new Map<string, number>();

export function tableContextWindow(model: string): number {
  for (const [re, n] of WINDOW_TABLE) if (re.test(model)) return n;
  return DEFAULT_WINDOW;
}

/** Synchronous best-known window (cache → table). Safe for render paths. */
export function cachedContextWindow(model: string): number {
  return cache.get(model) ?? tableContextWindow(model);
}

/**
 * Resolve the model's context window, best-effort: query `{endpoint}/models`,
 * read context_length/context_window, cache it; else fall back to the table.
 * Never throws; never blocks startup beyond a short timeout.
 */
export async function resolveContextWindow(cfg: ModelEndpoint, timeoutMs = 2500): Promise<number> {
  if (cache.has(cfg.model)) return cache.get(cfg.model)!;
  const fetchImpl = cfg.fetchImpl ?? fetch;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetchImpl(`${cfg.endpoint.replace(/\/$/, "")}/models`, {
      headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (res.ok) {
      const json = (await res.json()) as { data?: Array<Record<string, unknown>>; models?: Array<Record<string, unknown>> };
      const list = json.data ?? json.models ?? [];
      const entry = list.find((m) => String(m.id ?? m.name ?? "").toLowerCase() === cfg.model.toLowerCase())
        ?? list.find((m) => String(m.id ?? m.name ?? "").toLowerCase().includes(cfg.model.toLowerCase()));
      const w = entry && pickWindow(entry);
      if (typeof w === "number" && w > 0) {
        cache.set(cfg.model, w);
        return w;
      }
    }
  } catch {
    /* network/timeout, fall through to table */
  }
  const t = tableContextWindow(cfg.model);
  cache.set(cfg.model, t);
  return t;
}

function pickWindow(entry: Record<string, unknown>): number | undefined {
  const candidates = [
    entry.context_length,
    entry.context_window,
    entry.max_context_length,
    entry.max_model_len,
    (entry.top_provider as { context_length?: unknown } | undefined)?.context_length,
  ];
  for (const c of candidates) if (typeof c === "number" && c > 0) return c;
  return undefined;
}

/** Rough token estimate when the provider doesn't report usage (~4 chars/token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => n + estimateTokens(m.content ?? "") + 4, 0);
}

/**
 * Tracks how full the context window is across a session. `used` is the size of
 * the last prompt sent (the live context), preferring provider-reported tokens.
 */
export class ContextMeter {
  used = 0;
  readonly startedAt = Date.now();

  constructor(public limit: number) {}

  /** Record the provider's reported usage for the last call. */
  observe(usage?: TokenUsage): void {
    if (usage?.prompt_tokens) this.used = usage.prompt_tokens;
  }

  /** Fallback: estimate from the current message array. */
  estimate(messages: ChatMessage[]): void {
    this.used = Math.max(this.used, estimateMessagesTokens(messages));
  }

  get pct(): number {
    return this.limit > 0 ? Math.min(1, this.used / this.limit) : 0;
  }
  get elapsedSeconds(): number {
    return (Date.now() - this.startedAt) / 1000;
  }
}

export interface CompactOptions {
  llm: ModelEndpoint;
  threshold?: number; // 0..0.95
  keepLastN?: number;
}

export interface CompactResult {
  messages: ChatMessage[];
  compacted: boolean;
  summary?: string;
  removed?: number;
}

/**
 * Compact the conversation when the meter crosses the threshold: summarize the
 * older messages into one, keep the system message + the last N turns. The
 * summary is produced by the model itself (Claude-Code style). Best-effort: if the
 * summarizer call fails, returns the messages unchanged (never breaks the session).
 */
export async function compactMessages(
  messages: ChatMessage[],
  meter: ContextMeter,
  opts: CompactOptions,
): Promise<CompactResult> {
  const threshold = Math.min(0.95, opts.threshold ?? 0.8);
  const keepLastN = opts.keepLastN ?? 10;
  if (meter.pct < threshold) return { messages, compacted: false };

  const system = messages.find((m) => m.role === "system");
  const rest = messages.filter((m) => m !== system);
  if (rest.length <= keepLastN + 1) return { messages, compacted: false };

  const older = rest.slice(0, rest.length - keepLastN);
  const recent = rest.slice(rest.length - keepLastN);

  const transcript = older
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n")
    .slice(0, 12000);

  let summary: string;
  try {
    summary = await summarize(opts.llm, transcript);
  } catch {
    return { messages, compacted: false };
  }

  const summaryMsg: ChatMessage = {
    role: "user",
    content: `<summary>\nEarlier conversation, condensed (decisions, facts, open tasks preserved):\n${summary}\n</summary>`,
  };
  const next = [...(system ? [system] : []), summaryMsg, ...recent];
  meter.used = estimateMessagesTokens(next);
  return { messages: next, compacted: true, summary, removed: older.length };
}

async function summarize(cfg: ModelEndpoint, transcript: string): Promise<string> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const res = await fetchImpl(`${cfg.endpoint.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: "system", content: "You compress conversations. Preserve all decisions, facts, names, numbers, and open tasks. Drop pleasantries. Output ONLY the summary prose." },
        { role: "user", content: `Summarize:\n${transcript}` },
      ],
      temperature: 0,
      max_tokens: 700,
    }),
  });
  if (!res.ok) throw new Error(`summarizer HTTP ${res.status}`);
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const out = (json.choices?.[0]?.message?.content ?? "").trim();
  if (!out) throw new Error("empty summary");
  return out;
}
