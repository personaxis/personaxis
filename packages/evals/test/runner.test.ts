import { describe, it, expect } from "vitest";
import { runScenarios, SCENARIOS } from "../src/index.js";
import type { Scenario } from "../src/types.js";

describe("governance eval suite", () => {
  it("all built-in governance scenarios pass on a correct engine", async () => {
    const report = await runScenarios();
    expect(report.total).toBe(SCENARIOS.length);
    expect(report.failed).toBe(0);
    expect(report.passRate).toBe(1);
  }, 30000);

  it("covers governance, security, and spec-fidelity categories", async () => {
    const report = await runScenarios();
    expect(Object.keys(report.byCategory).sort()).toEqual(["governance", "security", "spec-fidelity"]);
  }, 30000);

  it("proves all three conformance classes C0/C1/C2 (each MET only when every scenario passes)", async () => {
    const report = await runScenarios();
    expect(report.byClass.C0.met).toBe(true);
    expect(report.byClass.C1.met).toBe(true);
    expect(report.byClass.C2.met).toBe(true);
    // Every scenario carries a conformance class.
    expect(report.results.every((r) => ["C0", "C1", "C2"].includes(r.conformanceClass))).toBe(true);
  }, 30000);

  it("a failing scenario un-MEETs its conformance class", async () => {
    const brokenC1: Scenario = {
      id: "broken-c1",
      category: "governance",
      conformanceClass: "C1",
      description: "stand-in for a broken clamp",
      async run() {
        return { id: "broken-c1", category: "governance", conformanceClass: "C1", description: "x", passed: false, score: 0, checks: [{ name: "clamp", pass: false, detail: "escaped" }] };
      },
    };
    const report = await runScenarios([brokenC1]);
    expect(report.byClass.C1.met).toBe(false);
    expect(report.byClass.C0.met).toBe(false); // no C0 scenarios present → nothing proven
  });

  it("a regression (a broken invariant) fails the suite", async () => {
    // A synthetic scenario standing in for a broken engine invariant.
    const broken: Scenario = {
      id: "synthetic-regression",
      category: "governance",
      conformanceClass: "C1",
      description: "stand-in for a broken clamp",
      async run() {
        return { id: "synthetic-regression", category: "governance", conformanceClass: "C1", description: "x", passed: false, score: 0, checks: [{ name: "clamp", pass: false, detail: "value escaped envelope" }] };
      },
    };
    const report = await runScenarios([broken]);
    expect(report.failed).toBe(1);
    expect(report.passRate).toBe(0);
  });
});
