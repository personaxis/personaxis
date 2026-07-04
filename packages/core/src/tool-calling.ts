/**
 * Tool-calling client (G1) — provider-agnostic action proposals.
 *
 * Primary path: OpenAI-style native function-calling (`tools` + `tool_choice`),
 * which Cohere/OpenAI/together/etc. expose on /chat/completions. Fallback path
 * (when an endpoint rejects `tools` with a 400): a ReAct-style single-action JSON
 * (`{thought, tool, args}`) under the same constrained-decoding strategy chain the
 * appraiser uses (json_schema → json_object → plain). Either way the model only
 * *proposes* a tool call; the agent loop gates + executes.
 */

import { repairToolArgs } from "./tool-repair.js";
import type { ToolSpec } from "./tools/registry.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** For assistant turns that issued tool calls (echoed back to the model). */
  tool_calls?: RawToolCall[];
  /** For role:"tool" results. */
  tool_call_id?: string;
  name?: string;
}

interface RawToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ToolCallResponse {
  /** Assistant free text accompanying the call (may be empty). */
  text: string;
  toolCalls: ToolCall[];
  usedFallback: boolean;
  /** Token accounting from the provider (for budget enforcement), when reported. */
  usage?: TokenUsage;
}

function extractUsage(json: { usage?: Partial<TokenUsage> }): TokenUsage | undefined {
  const u = json.usage;
  if (!u) return undefined;
  const total = u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0);
  return { prompt_tokens: u.prompt_tokens ?? 0, completion_tokens: u.completion_tokens ?? 0, total_tokens: total };
}

export interface ToolCallConfig {
  endpoint: string;
  model: string;
  apiKey?: string;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
}

function url(cfg: ToolCallConfig): string {
  return `${cfg.endpoint.replace(/\/$/, "")}/chat/completions`;
}
function headers(cfg: ToolCallConfig): Record<string, string> {
  return { "content-type": "application/json", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    // FR.10 (OpenClaw port): salvage almost-JSON before giving up — a repaired
    // call saves a full model round-trip on weaker tool-callers.
    const r = repairToolArgs(raw);
    return r.ok && r.value ? r.value : {};
  }
}

/**
 * Request the next action. `preferFallback` lets the caller skip the native
 * attempt once it has learned the endpoint doesn't support `tools`.
 */
export async function requestToolCall(
  cfg: ToolCallConfig,
  messages: ChatMessage[],
  tools: ToolSpec[],
  preferFallback = false,
): Promise<ToolCallResponse> {
  const fetchImpl = cfg.fetchImpl ?? fetch;

  if (!preferFallback) {
    const body = {
      model: cfg.model,
      messages,
      tools: tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      tool_choice: "auto",
      temperature: 0.3,
      max_tokens: cfg.maxTokens ?? 1024,
    };
    const res = await fetchImpl(url(cfg), { method: "POST", headers: headers(cfg), body: JSON.stringify(body) });
    if (res.ok) {
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string; tool_calls?: RawToolCall[] } }>;
        usage?: Partial<TokenUsage>;
      };
      const msg = json.choices?.[0]?.message ?? {};
      const toolCalls = (msg.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        args: parseArgs(tc.function.arguments),
      }));
      return { text: (msg.content ?? "").trim(), toolCalls, usedFallback: false, usage: extractUsage(json) };
    }
    // Auth/rate/server errors won't be fixed by the fallback — surface them.
    if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) {
      throw new Error(`tool-calling HTTP ${res.status}: ${await safeText(res)}`);
    }
    // 400/422 → endpoint likely doesn't support `tools`; degrade to ReAct.
  }

  return reactFallback(cfg, messages, tools);
}

const REACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["tool", "args"],
  properties: {
    thought: { type: "string" },
    tool: { type: "string" },
    args: { type: "object" },
  },
} as const;

/** ReAct fallback: render the transcript to text, ask for ONE JSON action. */
async function reactFallback(
  cfg: ToolCallConfig,
  messages: ChatMessage[],
  tools: ToolSpec[],
): Promise<ToolCallResponse> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const toolDocs = tools
    .map((t) => `- ${t.name}(${Object.keys((t.parameters as { properties?: object }).properties ?? {}).join(", ")}): ${t.description}`)
    .join("\n");
  const transcript = messages
    .map((m) => {
      if (m.role === "tool") return `TOOL_RESULT[${m.name ?? ""}]: ${m.content}`;
      if (m.role === "assistant" && m.tool_calls?.length)
        return `ASSISTANT called: ${m.tool_calls.map((tc) => `${tc.function.name}(${tc.function.arguments})`).join(", ")}`;
      return `${m.role.toUpperCase()}: ${m.content}`;
    })
    .join("\n");

  const system = [
    messages.find((m) => m.role === "system")?.content ?? "",
    "",
    "You are an agent that acts ONLY by emitting a single JSON action.",
    "Available tools:",
    toolDocs,
    "",
    'Respond with exactly one JSON object: {"thought": string, "tool": string, "args": object}.',
    'When the task is complete, use {"tool":"finish","args":{"summary":"..."}}.',
  ].join("\n");

  const strategies: Array<Record<string, unknown> | undefined> = [
    { type: "json_schema", json_schema: { name: "agent_action", strict: true, schema: REACT_SCHEMA } },
    { type: "json_object" },
    undefined,
  ];

  let lastErr = "no response";
  for (const responseFormat of strategies) {
    const body = {
      model: cfg.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Transcript so far:\n${transcript}\n\nEmit the next action as JSON.` },
      ],
      ...(responseFormat ? { response_format: responseFormat } : {}),
      temperature: 0.3,
      max_tokens: cfg.maxTokens ?? 1024,
    };
    const res = await fetchImpl(url(cfg), { method: "POST", headers: headers(cfg), body: JSON.stringify(body) });
    if (res.ok) {
      const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: Partial<TokenUsage> };
      const usage = extractUsage(json);
      const content = json.choices?.[0]?.message?.content ?? "{}";
      let parsed: { thought?: string; tool?: string; args?: Record<string, unknown> };
      try {
        parsed = JSON.parse(content);
      } catch {
        const m = content.match(/\{[\s\S]*\}/);
        try {
          parsed = m ? JSON.parse(m[0]) : {};
        } catch {
          const r = repairToolArgs(m ? m[0] : content); // FR.10 repair pass
          parsed = r.ok && r.value ? (r.value as typeof parsed) : {};
        }
      }
      if (!parsed.tool) {
        return { text: parsed.thought ?? content.slice(0, 200), toolCalls: [], usedFallback: true, usage };
      }
      return {
        text: parsed.thought ?? "",
        toolCalls: [{ id: `react_${Date.now()}`, name: parsed.tool, args: parsed.args ?? {} }],
        usedFallback: true,
        usage,
      };
    }
    lastErr = `HTTP ${res.status}: ${await safeText(res)}`;
    if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) break;
  }
  throw new Error(`tool-calling fallback ${lastErr}`);
}
