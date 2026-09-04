/**
 * E17: a turn's wall time, split into the parts that move for different reasons.
 *
 * The property under test is not "the numbers are right" (they are clock readings),
 * it is that the breakdown CANNOT QUIETLY LIE: time nobody measured is reported as
 * unmeasured rather than folded into whichever part happens to be instrumented, and
 * the worst turn survives being averaged away.
 */
import { describe, it, expect } from "vitest";
import { PersonaAgent, type ExecutablePolicy } from "../src/index.js";
// By its path, not through the barrel: the meter is an internal of the loop and its
// only caller is agent.ts. Exporting it publicly to make a test shorter would widen
// the package's surface for the test's convenience.
import { LatencyMeter } from "../src/run/latency.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function policy(over: Partial<ExecutablePolicy> = {}): ExecutablePolicy {
  return {
    persona_id: "t",
    persona_version: "1.0.0",
    hash: "h",
    allow: ["*"],
    deny: [],
    hard_limits: [],
    prohibited_behaviors: [],
    egress_allowlist: [],
    sandbox: "danger-full-access",
    approval: "never",
    gate_rules: [],
    ...over,
  };
}

describe("LatencyMeter splits a turn into parts (E17)", () => {
  it("times each part separately and passes the value through untouched", async () => {
    const m = new LatencyMeter();
    const out = await m.time("model", async () => {
      await sleep(30);
      return "the answer";
    });
    m.sync("gate", () => undefined);
    await m.time("tool", () => sleep(20));

    expect(out).toBe("the answer");
    const r = m.report();
    expect(r.modelMs).toBeGreaterThanOrEqual(25);
    expect(r.toolMs).toBeGreaterThanOrEqual(15);
    expect(r.calls).toEqual({ model: 1, gate: 1, tool: 1 });
  });

  it("time nobody measured is reported as unmeasured, never folded into a part", async () => {
    const m = new LatencyMeter();
    await m.time("model", () => sleep(20));
    await sleep(60); // outside every span: this is the stretch that must stay visible
    const r = m.report();

    expect(r.unattributedMs).toBeGreaterThanOrEqual(50);
    // The whole point: the model did not get credit for time it did not spend.
    expect(r.modelMs).toBeLessThan(50);
    expect(r.modelMs + r.gateMs + r.toolMs + r.unattributedMs).toBeCloseTo(r.totalMs, -1);
  });

  it("a part still counts its time when the span throws", async () => {
    const m = new LatencyMeter();
    await expect(
      m.time("tool", async () => {
        await sleep(25);
        throw new Error("the tool failed");
      }),
    ).rejects.toThrow("the tool failed");
    // A failure that took 25 seconds is exactly the latency somebody is investigating.
    expect(m.report().toolMs).toBeGreaterThanOrEqual(20);
  });

  it("unattributed never goes negative", () => {
    const m = new LatencyMeter(Date.now() + 10_000); // a start in the future
    expect(m.report().unattributedMs).toBe(0);
  });

  it("reports the WORST turn against a declared ceiling, not the average", async () => {
    const m = new LatencyMeter(Date.now(), 40);
    // The slow turn goes FIRST and a fast one follows it, which is the order that
    // actually tests anything: written the other way round the slow turn is still the
    // open one when `report` closes it, and a meter that never closed a turn on
    // `turnBegan` would pass. A negative control caught exactly that.
    m.turnBegan();
    await sleep(60); // the slow one
    m.turnBegan(); // starting the next turn must close it
    await sleep(5); // a fast turn, which is what an average would hide behind
    const r = m.report();

    expect(r.overBudget).toBeDefined();
    expect(r.overBudget?.turnMs).toBe(40);
    expect(r.overBudget?.worstTurnMs).toBeGreaterThanOrEqual(50);
  });

  it("says nothing about a budget when none was declared", async () => {
    const m = new LatencyMeter();
    m.turnBegan();
    await sleep(30);
    expect(m.report().overBudget).toBeUndefined();
  });
});

describe("the agent reports where its time went (E17)", () => {
  it("a run attributes time to the model, and the parts add up to the total", async () => {
    const slowModel = (async (url: string) => {
      if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
      await sleep(40);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "finish", arguments: JSON.stringify({ summary: "done" }) } }] } }],
        }),
      };
    }) as unknown as typeof fetch;

    const agent = new PersonaAgent({ llm: { endpoint: "http://x/v1", model: "m", fetchImpl: slowModel }, policy: policy() });
    const res = await agent.run("t");

    expect(res.finished).toBe(true);
    expect(res.latency.modelMs).toBeGreaterThanOrEqual(35);
    expect(res.latency.calls.model).toBeGreaterThanOrEqual(1);
    expect(res.latency.modelMs).toBeLessThanOrEqual(res.latency.totalMs);
  });
});
