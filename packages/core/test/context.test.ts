import { describe, it, expect } from "vitest";
import {
  resolveContextWindow,
  tableContextWindow,
  cachedContextWindow,
  ContextMeter,
  compactMessages,
  estimateMessagesTokens,
  type ChatMessage,
} from "../src/index.js";

function fetchModels(data: unknown): typeof fetch {
  return (async () => ({ ok: true, status: 200, json: async () => ({ data }) })) as unknown as typeof fetch;
}

describe("context window resolution", () => {
  it("table fallback by model pattern", () => {
    expect(tableContextWindow("command-a-03-2025")).toBe(256_000);
    expect(tableContextWindow("claude-opus-4-8")).toBe(200_000);
    expect(tableContextWindow("totally-unknown")).toBe(32_768);
  });

  it("reads context_length from /models when available (and caches)", async () => {
    const cfg = { endpoint: "http://x/v1", model: "my-model-xyz", fetchImpl: fetchModels([{ id: "my-model-xyz", context_length: 131072 }]) };
    expect(await resolveContextWindow(cfg)).toBe(131072);
    expect(cachedContextWindow("my-model-xyz")).toBe(131072); // cached, sync
  });

  it("falls back to the table when /models fails", async () => {
    const bad = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await resolveContextWindow({ endpoint: "http://x/v1", model: "command-a-plus", fetchImpl: bad })).toBe(256_000);
  });
});

describe("ContextMeter", () => {
  it("tracks fill from provider usage", () => {
    const m = new ContextMeter(1000);
    m.observe({ prompt_tokens: 800, completion_tokens: 50, total_tokens: 850 });
    expect(m.used).toBe(800);
    expect(m.pct).toBeCloseTo(0.8);
  });
});

describe("compactMessages", () => {
  const msgs = (n: number): ChatMessage[] => [
    { role: "system", content: "you are X" },
    ...Array.from({ length: n }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as ChatMessage["role"], content: `turn ${i} ` + "word ".repeat(50) })),
  ];

  it("does nothing below threshold", async () => {
    const m = new ContextMeter(1_000_000);
    m.used = 10;
    const r = await compactMessages(msgs(20), m, { llm: { endpoint: "http://x/v1", model: "m" } });
    expect(r.compacted).toBe(false);
  });

  it("summarizes older turns and keeps the system + last N", async () => {
    const m = new ContextMeter(1000);
    m.used = 900; // 90% → over threshold
    const summarizer = (async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "CONDENSED" } }] }) })) as unknown as typeof fetch;
    const r = await compactMessages(msgs(30), m, { llm: { endpoint: "http://x/v1", model: "m", fetchImpl: summarizer }, keepLastN: 6 });
    expect(r.compacted).toBe(true);
    expect(r.messages[0].role).toBe("system");
    expect(r.messages[1].content).toContain("CONDENSED");
    expect(r.messages.length).toBe(1 + 1 + 6); // system + summary + last 6
    expect(r.removed).toBeGreaterThan(0);
  });

  it("never breaks the session if the summarizer fails", async () => {
    const m = new ContextMeter(1000);
    m.used = 950;
    const failing = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;
    const r = await compactMessages(msgs(30), m, { llm: { endpoint: "http://x/v1", model: "m", fetchImpl: failing } });
    expect(r.compacted).toBe(false); // returned unchanged
  });
});
