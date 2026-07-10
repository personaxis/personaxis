import { describe, it, expect } from "vitest";
import {
  runVerification,
  readVerification,
  readAgentBudget,
  checkAgentBudget,
  estimateCostUsd,
  DEFAULT_POLICY,
  type VerificationConfig,
  type JudgeConfig,
} from "../src/index.js";

const base: VerificationConfig = { mode: "blocking", quorum: "all", onFail: "stop", maxRetries: 0, gates: [] };
const ctx = (output: string) => ({ task: "t", output });

function judgeReturning(obj: unknown): JudgeConfig {
  return {
    endpoint: "http://x/v1",
    model: "judge",
    fetchImpl: (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(obj) } }] }),
    })) as unknown as typeof fetch,
  };
}

describe("predicate gates", () => {
  it("contains pass/fail", async () => {
    const cfg = { ...base, gates: [{ type: "predicate" as const, kind: "contains" as const, expr: "DONE" }] };
    expect((await runVerification(cfg, ctx("all DONE"))).passed).toBe(true);
    expect((await runVerification(cfg, ctx("nope"))).passed).toBe(false);
  });
  it("regex", async () => {
    const cfg = { ...base, gates: [{ type: "predicate" as const, kind: "regex" as const, expr: "^ok-\\d+$" }] };
    expect((await runVerification(cfg, ctx("ok-42"))).passed).toBe(true);
    expect((await runVerification(cfg, ctx("ok-x"))).passed).toBe(false);
  });
  it("jsonpath truthiness over JSON output", async () => {
    const cfg = { ...base, gates: [{ type: "predicate" as const, kind: "jsonpath" as const, expr: "$.result.ok" }] };
    expect((await runVerification(cfg, ctx('{"result":{"ok":true}}'))).passed).toBe(true);
    expect((await runVerification(cfg, ctx('{"result":{"ok":false}}'))).passed).toBe(false);
  });
});

describe("llm_judge + rubric gates (mocked judge)", () => {
  it("llm_judge passes when the checker says pass", async () => {
    const cfg = { ...base, gates: [{ type: "llm_judge" as const, criteria: "done" }] };
    const r = await runVerification(cfg, ctx("x"), { judge: judgeReturning({ pass: true, reason: "ok" }) });
    expect(r.passed).toBe(true);
  });
  it("llm_judge fails when the checker says fail", async () => {
    const cfg = { ...base, gates: [{ type: "llm_judge" as const, criteria: "done" }] };
    const r = await runVerification(cfg, ctx("x"), { judge: judgeReturning({ pass: false, reason: "missing" }) });
    expect(r.passed).toBe(false);
  });
  it("rubric passes when weighted score ≥ threshold", async () => {
    const cfg = {
      ...base,
      gates: [{ type: "rubric" as const, threshold: 0.7, dimensions: [{ name: "completeness", weight: 0.5 }, { name: "safety", weight: 0.5 }] }],
    };
    const r = await runVerification(cfg, ctx("x"), { judge: judgeReturning({ scores: { completeness: 0.8, safety: 0.9 } }) });
    expect(r.passed).toBe(true);
    const r2 = await runVerification(cfg, ctx("x"), { judge: judgeReturning({ scores: { completeness: 0.4, safety: 0.5 } }) });
    expect(r2.passed).toBe(false);
  });
  it("llm gates are skipped (pass) when no judge is configured", async () => {
    const cfg = { ...base, gates: [{ type: "llm_judge" as const, criteria: "done" }] };
    expect((await runVerification(cfg, ctx("x"))).passed).toBe(true);
  });
});

describe("command gate (real exit code)", () => {
  // Two real node spawns; under full-suite load they exceed vitest's 5 s
  // default on Windows (PA infra fix, FASE 7). Gate timeouts are already 15 s.
  it("passes on exit 0, fails on exit 1", async () => {
    const pass = { ...base, gates: [{ type: "command" as const, run: "node -e \"process.exit(0)\"", timeout_ms: 30000 }] };
    const fail = { ...base, gates: [{ type: "command" as const, run: "node -e \"process.exit(1)\"", timeout_ms: 30000 }] };
    expect((await runVerification(pass, ctx("x"), { policy: { ...DEFAULT_POLICY, sandbox: "danger-full-access" } })).passed).toBe(true);
    expect((await runVerification(fail, ctx("x"), { policy: { ...DEFAULT_POLICY, sandbox: "danger-full-access" } })).passed).toBe(false);
  }, 90_000);
});

describe("quorum + readers", () => {
  it("majority quorum: 2 of 3 pass", async () => {
    const cfg: VerificationConfig = {
      ...base,
      quorum: "majority",
      gates: [
        { type: "predicate", kind: "contains", expr: "a" },
        { type: "predicate", kind: "contains", expr: "b" },
        { type: "predicate", kind: "contains", expr: "z" },
      ],
    };
    expect((await runVerification(cfg, ctx("a b"))).passed).toBe(true); // 2/3 ≥ majority(2)
  });

  it("readVerification parses the spec block", () => {
    const v = readVerification({ verification: { mode: "blocking", quorum: "majority", on_fail: "retry", max_retries: 2, gates: [{ type: "command", run: "x" }] } });
    expect(v.mode).toBe("blocking");
    expect(v.quorum).toBe("majority");
    expect(v.gates.length).toBe(1);
  });

  it("readAgentBudget parses caps + stop conditions", () => {
    const b = readAgentBudget({ agent_budget: { max_steps: 5, max_tokens: 1000, stop_conditions: ["goal_met", "bogus"], on_exhaust: "summarize_and_stop" } });
    expect(b.maxSteps).toBe(5);
    expect(b.maxTokens).toBe(1000);
    expect(b.stopConditions).toEqual(["goal_met"]);
    expect(b.onExhaust).toBe("summarize_and_stop");
  });

  it("checkAgentBudget stops on step/token caps and cost estimate", () => {
    expect(checkAgentBudget({ steps: 5, tokens: 0, costUsd: 0, wallSeconds: 0, deniedCount: 0, errorCount: 0, progress: 1 }, { maxSteps: 5, stopConditions: [], onExhaust: "stop" }).stopReason).toBe("max_steps");
    expect(checkAgentBudget({ steps: 1, tokens: 2000, costUsd: 0, wallSeconds: 0, deniedCount: 0, errorCount: 0, progress: 1 }, { maxSteps: 99, maxTokens: 1000, stopConditions: [], onExhaust: "stop" }).stopReason).toBe("max_tokens");
    expect(estimateCostUsd("command-a-03-2025", 1_000_000)).toBeGreaterThan(0);
  });
});
