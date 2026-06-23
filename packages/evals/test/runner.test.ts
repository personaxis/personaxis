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

  it("a regression (a broken invariant) fails the suite", async () => {
    // A synthetic scenario standing in for a broken engine invariant.
    const broken: Scenario = {
      id: "synthetic-regression",
      category: "governance",
      description: "stand-in for a broken clamp",
      async run() {
        return { id: "synthetic-regression", category: "governance", description: "x", passed: false, score: 0, checks: [{ name: "clamp", pass: false, detail: "value escaped envelope" }] };
      },
    };
    const report = await runScenarios([broken]);
    expect(report.failed).toBe(1);
    expect(report.passRate).toBe(0);
  });
});
