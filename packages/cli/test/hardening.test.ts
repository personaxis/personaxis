/**
 * F6.5, pipeline hardening regression tests.
 *
 *  - postJson: 429/5xx retried with backoff, non-retryable 4xx fails fast WITH
 *    the response-body excerpt (the part that says WHY), success passes through;
 *  - runWithRepair: first-try accept, error-fed repair (the critique reaches the
 *    follow-up prompt), bounded exhaustion with the full critique trail.
 */
import { describe, it, expect } from "vitest";
import { postJson } from "../src/providers/http.js";
import { runWithRepair } from "../src/llm-repair.js";
import type { Provider } from "../src/providers/types.js";

const noSleep = async (): Promise<void> => {};

function fetchScript(responses: Array<{ status: number; body: unknown }>): typeof fetch {
  let i = 0;
  return (async () => {
    const r = responses[Math.min(i++, responses.length - 1)];
    return {
      ok: r.status < 400,
      status: r.status,
      statusText: String(r.status),
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    };
  }) as unknown as typeof fetch;
}

describe("postJson (hardened HTTP)", () => {
  it("retries 429 and 5xx, then succeeds", async () => {
    const json = await postJson("http://x/v1", {}, { a: 1 }, {
      fetchImpl: fetchScript([
        { status: 429, body: { error: "rate limited" } },
        { status: 503, body: { error: "overloaded" } },
        { status: 200, body: { ok: true } },
      ]),
      sleep: noSleep,
    });
    expect(json).toEqual({ ok: true });
  });

  it("fails fast on 400 and carries the body excerpt", async () => {
    await expect(
      postJson("http://x/v1", {}, {}, {
        fetchImpl: fetchScript([{ status: 400, body: { error: { message: "unknown field: bands" } } }]),
        sleep: noSleep,
      }),
    ).rejects.toThrow(/400.*unknown field: bands/s);
  });

  it("exhausts retries on persistent 5xx with the last error", async () => {
    await expect(
      postJson("http://x/v1", {}, {}, {
        fetchImpl: fetchScript([{ status: 500, body: { error: "boom" } }]),
        sleep: noSleep,
        retries: 2,
      }),
    ).rejects.toThrow(/500/);
  });
});

function scriptedProvider(outputs: string[]): { provider: Provider; prompts: string[] } {
  const prompts: string[] = [];
  let i = 0;
  return {
    prompts,
    provider: {
      name: "local",
      source: "cli-local",
      async run(prompt: string) {
        prompts.push(prompt);
        return { text: outputs[Math.min(i++, outputs.length - 1)], model: "scripted", source: "cli-local" as const };
      },
    },
  };
}

describe("runWithRepair (error-fed repair loop)", () => {
  it("accepts a valid first attempt without extra rounds", async () => {
    const { provider, prompts } = scriptedProvider(["GOOD"]);
    const r = await runWithRepair({ provider, prompt: "P", critique: (t) => (t === "GOOD" ? null : "bad") });
    expect("failed" in r).toBe(false);
    if (!("failed" in r)) {
      expect(r.rounds).toBe(1);
      expect(r.critiques).toEqual([]);
    }
    expect(prompts).toEqual(["P"]);
  });

  it("feeds the EXACT critique back and accepts the repaired round", async () => {
    const { provider, prompts } = scriptedProvider(["BAD-1", "GOOD"]);
    const r = await runWithRepair({
      provider,
      prompt: "P",
      critique: (t) => (t === "GOOD" ? null : "- affect.baseline: must NOT have additional properties"),
    });
    expect("failed" in r).toBe(false);
    if (!("failed" in r)) expect(r.rounds).toBe(2);
    // The follow-up prompt carries the original task, the exact error, and the failed candidate.
    expect(prompts[1]).toContain("P");
    expect(prompts[1]).toContain("must NOT have additional properties");
    expect(prompts[1]).toContain("BAD-1");
  });

  it("gives up after maxRounds with the full critique trail (never a silent pass)", async () => {
    const { provider, prompts } = scriptedProvider(["BAD-1", "BAD-2", "BAD-3", "BAD-4"]);
    const r = await runWithRepair({ provider, prompt: "P", critique: () => "still wrong", maxRounds: 3 });
    expect("failed" in r).toBe(true);
    if ("failed" in r) {
      expect(r.critiques).toHaveLength(3);
      expect(r.last.text).toBe("BAD-3");
    }
    expect(prompts).toHaveLength(3);
  });
});
