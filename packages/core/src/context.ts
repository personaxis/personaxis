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
 * E18: the session's cache accounting. Every field is what a provider reported or a
 * count of how often it reported anything; nothing here is inferred.
 */
export interface CacheReport {
  /** Did ANY call come back with cache numbers? False means silence, not a miss. */
  reported: boolean;
  /** Calls whose usage was reported at all. */
  calls: number;
  /** Of those, how many carried cache figures. */
  callsReportingCache: number;
  readTokens: number;
  writeTokens: number;
  promptTokens: number;
  /** Share of prompt tokens served from cache. Undefined while nothing was reported. */
  hitRate?: number;
}

/**
 * Tracks how full the context window is across a session. `used` is the size of
 * the last prompt sent (the live context), preferring provider-reported tokens.
 */
export class ContextMeter {
  used = 0;
  readonly startedAt = Date.now();

  /** E18: cache accounting, summed over the session. See `cacheReport`. */
  private cacheReads = 0;
  private cacheWrites = 0;
  private promptTokens = 0;
  private calls = 0;
  private callsReportingCache = 0;
  private compactions = 0;
  private tokensFreed = 0;

  constructor(public limit: number) {}

  /** Record the provider's reported usage for the last call. */
  observe(usage?: TokenUsage): void {
    if (usage?.prompt_tokens) this.used = usage.prompt_tokens;
    if (!usage) return;
    this.calls += 1;
    this.promptTokens += usage.prompt_tokens ?? 0;
    const read = usage.cache_read_tokens;
    const write = usage.cache_write_tokens;
    if (read === undefined && write === undefined) return;
    this.callsReportingCache += 1;
    this.cacheReads += read ?? 0;
    this.cacheWrites += write ?? 0;
  }

  /**
   * E18: what the cache actually did this session, as numbers rather than as faith.
   *
   * `E5` shaped a stable prompt prefix and `E6` gave compaction named cut points, and
   * both are bets on the provider serving a cached prefix. Neither was ever observed.
   * This reports what the provider said, and says plainly when it said nothing:
   * `reported: false` is not a miss, it is silence, and treating silence as a miss (or
   * as a hit) is how a prefix that stopped being cacheable stays invisible.
   *
   * `hitRate` is the share of PROMPT tokens served from cache, not the share of calls:
   * a call that reads 8k cached tokens and one that reads 40 are not the same event,
   * and the bill is denominated in tokens.
   */
  cacheReport(): CacheReport {
    const reported = this.callsReportingCache > 0;
    return {
      reported,
      calls: this.calls,
      callsReportingCache: this.callsReportingCache,
      readTokens: this.cacheReads,
      writeTokens: this.cacheWrites,
      promptTokens: this.promptTokens,
      hitRate: reported && this.promptTokens > 0 ? this.cacheReads / this.promptTokens : undefined,
    };
  }

  /** Fallback: estimate from the current message array. */
  estimate(messages: ChatMessage[]): void {
    this.used = Math.max(this.used, estimateMessagesTokens(messages));
  }

  /**
   * E18: record a compaction against the SESSION.
   *
   * `AgentResult.compactions` already carries one record per compaction, and this is
   * not a second copy of it: that array is per RUN and holds the detail, while a
   * session outlives its runs and is what somebody is looking at when they type
   * /context. The run's array was also, as of E18, read by nobody at all: E6 measured
   * the cost and then had nowhere to put it.
   */
  compacted(before: number, after: number): void {
    this.compactions += 1;
    this.tokensFreed += Math.max(0, before - after);
  }

  /** How many times this session compacted, and what that bought. */
  compactionReport(): { count: number; tokensFreed: number } {
    return { count: this.compactions, tokensFreed: this.tokensFreed };
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
  /**
   * J.6: authoritative task state (goal, plan, decisions) rendered by the caller. It is
   * pinned VERBATIM as a system message ahead of the summary, so the run's objective and
   * plan survive compaction by construction, not at the mercy of the summarizer.
   */
  pinned?: string;
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

  // THE WHOLE leading system block, not the first message of it.
  //
  // It used to keep `messages.find(m => m.role === "system")`, one message, and drop
  // every other system message with the transcript. That already lost a persona its
  // skill guides on any long run, and E5 made it worse by splitting the prompt: the
  // identity, the guides and what the persona remembers are three messages now, and
  // this kept the first and threw the other two away.
  //
  // The leading block is also exactly the cacheable prefix, so keeping it whole is
  // the same rule read from the other side: compaction rewrites the transcript, and
  // it must not touch what comes before it.
  let prefixEnd = 0;
  while (prefixEnd < messages.length && messages[prefixEnd]!.role === "system") prefixEnd += 1;
  const prefix = messages.slice(0, prefixEnd);
  const rest = messages.slice(prefixEnd);
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
  // J.6: the pinned task state goes in as SYSTEM speech ahead of the summary, so the goal and
  // plan are authoritative and never diluted by summarization.
  const pinnedMsg: ChatMessage[] = opts.pinned?.trim()
    ? [{ role: "system", content: opts.pinned.trim() }]
    : [];
  const next = [...prefix, ...pinnedMsg, summaryMsg, ...recent];
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
        {
          role: "system",
          content:
            "You compress conversations into a structured handoff. Output ONLY the summary, using exactly these section headers, omitting any that would be empty:\n" +
            "## Decisions taken\n## Current task state\n## Files and artifacts touched\n## Facts to remember\n## Open items and next steps\n" +
            "Preserve names, numbers, paths, commands and identifiers VERBATIM. Drop pleasantries and dead ends. Be dense, not chatty.",
        },
        { role: "user", content: `Summarize:\n${transcript}` },
      ],
      temperature: 0,
      max_tokens: 900,
    }),
  });
  if (!res.ok) throw new Error(`summarizer HTTP ${res.status}`);
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const out = (json.choices?.[0]?.message?.content ?? "").trim();
  if (!out) throw new Error("empty summary");
  return out;
}
