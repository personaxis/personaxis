/**
 * E18: the prompt cache is measured, not assumed.
 *
 * E5 shaped a stable prefix and E6 gave compaction named cut points. Both are bets
 * that a provider serves that prefix from cache, and nothing ever checked. These tests
 * hold the line that matters most: SILENCE AND A MISS ARE DIFFERENT FACTS. A provider
 * that reports nothing and a provider that reports zero hits produce the same zero if
 * you are careless, and the careless reading is the one that lets a prefix stop being
 * cacheable without anyone noticing.
 */
import { describe, it, expect } from "vitest";
import { ContextMeter, PersonaAgent, type Policy } from "../src/index.js";

/**
 * The SANDBOX policy, which is what `PersonaAgent.policy` takes.
 *
 * Written wrong the first time, and worth the note: this used to be typed
 * `ExecutablePolicy` and shaped like a `CompiledPolicy`, so it was neither of the two
 * things it claimed to be. Nothing complained, because no package type-checks its own
 * tests, and JavaScript happily read `sandbox` off an object that had it by accident.
 * These tests measure token accounting, so a broken policy did not change their
 * result, which is exactly what makes the mistake worth writing down rather than
 * quietly fixing.
 */
function policy(over: Partial<Policy> = {}): Policy {
  return {
    sandbox: "danger-full-access",
    approval: "never",
    allow: [],
    deny: [],
    workspaceRoot: process.cwd(),
    ...over,
  };
}

/** A scripted endpoint that also reports whatever `usage` the test hands it. */
function fetchReporting(usages: Array<Record<string, unknown> | undefined>): typeof fetch {
  let i = 0;
  return (async (url: string) => {
    if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
    const usage = usages[Math.min(i, usages.length - 1)];
    i++;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "finish", arguments: JSON.stringify({ summary: "done" }) } }] } }],
        ...(usage ? { usage } : {}),
      }),
    };
  }) as unknown as typeof fetch;
}

describe("cache accounting is read from both dialects (E18)", () => {
  it("reads Anthropic's spelling: read and creation tokens", async () => {
    const agent = new PersonaAgent({
      llm: { endpoint: "http://x/v1", model: "m", fetchImpl: fetchReporting([
        { prompt_tokens: 1000, completion_tokens: 10, cache_read_input_tokens: 800, cache_creation_input_tokens: 200 },
      ]) },
      policy: policy(),
    });
    const res = await agent.run("t");
    expect(res.cache.reported).toBe(true);
    expect(res.cache.readTokens).toBe(800);
    expect(res.cache.writeTokens).toBe(200);
    expect(res.cache.hitRate).toBeCloseTo(0.8);
  });

  it("reads OpenAI's spelling, which nests the read and never bills a write", async () => {
    const agent = new PersonaAgent({
      llm: { endpoint: "http://x/v1", model: "m", fetchImpl: fetchReporting([
        { prompt_tokens: 500, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 250 } },
      ]) },
      policy: policy(),
    });
    const res = await agent.run("t");
    expect(res.cache.reported).toBe(true);
    expect(res.cache.readTokens).toBe(250);
    expect(res.cache.writeTokens).toBe(0);
    expect(res.cache.hitRate).toBeCloseTo(0.5);
  });

  it("a provider that says nothing about cache is SILENT, not a miss", async () => {
    const agent = new PersonaAgent({
      llm: { endpoint: "http://x/v1", model: "m", fetchImpl: fetchReporting([
        { prompt_tokens: 900, completion_tokens: 10 },
      ]) },
      policy: policy(),
    });
    const res = await agent.run("t");
    // The distinction this whole row exists for.
    expect(res.cache.reported).toBe(false);
    expect(res.cache.hitRate).toBeUndefined();
    expect(res.cache.callsReportingCache).toBe(0);
    // Usage still counted: silence is about the cache, not about the tokens.
    expect(res.cache.promptTokens).toBe(900);
  });

  it("a provider that reports ZERO hits is a miss, and reads differently from silence", async () => {
    const agent = new PersonaAgent({
      llm: { endpoint: "http://x/v1", model: "m", fetchImpl: fetchReporting([
        { prompt_tokens: 900, completion_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 900 },
      ]) },
      policy: policy(),
    });
    const res = await agent.run("t");
    expect(res.cache.reported).toBe(true);
    expect(res.cache.hitRate).toBe(0);
    // Paid to write the whole prompt and read none of it back: the exact shape of a
    // prefix that is being rebuilt every turn.
    expect(res.cache.writeTokens).toBe(900);
  });
});

describe("ContextMeter sums the session, not the call (E18)", () => {
  it("hitRate is the share of PROMPT TOKENS, not the share of calls", () => {
    const meter = new ContextMeter(100_000);
    // One big read and one small one. By call count this is 100%; by tokens it is not,
    // and the bill is denominated in tokens.
    meter.observe({ prompt_tokens: 10_000, completion_tokens: 10, total_tokens: 10_010, cache_read_tokens: 9_000 });
    meter.observe({ prompt_tokens: 1_000, completion_tokens: 10, total_tokens: 1_010, cache_read_tokens: 100 });
    const r = meter.cacheReport();
    expect(r.calls).toBe(2);
    expect(r.callsReportingCache).toBe(2);
    expect(r.readTokens).toBe(9_100);
    expect(r.hitRate).toBeCloseTo(9_100 / 11_000);
  });

  it("a mixed session reports partially: some calls carried figures, some did not", () => {
    const meter = new ContextMeter(100_000);
    meter.observe({ prompt_tokens: 1_000, completion_tokens: 5, total_tokens: 1_005 });
    meter.observe({ prompt_tokens: 1_000, completion_tokens: 5, total_tokens: 1_005, cache_read_tokens: 500 });
    const r = meter.cacheReport();
    expect(r.reported).toBe(true);
    expect(r.calls).toBe(2);
    expect(r.callsReportingCache).toBe(1);
    // Denominated over every prompt token the session paid for, not only the reported
    // half: an average that quietly changes its denominator is worse than no average.
    expect(r.hitRate).toBeCloseTo(500 / 2_000);
  });

  it("a session with no calls at all reports silence, and divides by nothing", () => {
    const r = new ContextMeter(100_000).cacheReport();
    expect(r.reported).toBe(false);
    expect(r.hitRate).toBeUndefined();
    expect(r.promptTokens).toBe(0);
  });

  it("compactions accumulate across the session, and a growth is never counted as a saving", () => {
    const meter = new ContextMeter(100_000);
    expect(meter.compactionReport()).toEqual({ count: 0, tokensFreed: 0 });
    meter.compacted(50_000, 20_000);
    meter.compacted(60_000, 25_000);
    // A compaction that ended larger than it started is still a compaction that
    // happened; it just did not free anything, and must not free negative tokens.
    meter.compacted(10_000, 12_000);
    expect(meter.compactionReport()).toEqual({ count: 3, tokensFreed: 65_000 });
  });
});
