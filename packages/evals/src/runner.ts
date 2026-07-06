import { SCENARIOS } from "./scenarios.js";
import type { Scenario, EvalReport, ScenarioResult, ConformanceClass } from "./types.js";

export async function runScenarios(scenarios: Scenario[] = SCENARIOS): Promise<EvalReport> {
  const results: ScenarioResult[] = [];
  for (const s of scenarios) {
    try {
      results.push(await s.run());
    } catch (e) {
      results.push({
        id: s.id,
        category: s.category,
        conformanceClass: s.conformanceClass,
        description: s.description,
        passed: false,
        score: 0,
        checks: [{ name: "ran", pass: false, detail: `threw: ${(e as Error).message}` }],
      });
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const byCategory: Record<string, { passed: number; total: number }> = {};
  for (const r of results) {
    byCategory[r.category] ??= { passed: 0, total: 0 };
    byCategory[r.category].total++;
    if (r.passed) byCategory[r.category].passed++;
  }

  // Conformance-class rollup: a class is MET only when every scenario in it passes.
  const byClass = {} as Record<ConformanceClass, { passed: number; total: number; met: boolean }>;
  for (const cls of ["C0", "C1", "C2"] as ConformanceClass[]) byClass[cls] = { passed: 0, total: 0, met: true };
  for (const r of results) {
    const b = byClass[r.conformanceClass];
    b.total++;
    if (r.passed) b.passed++;
    else b.met = false;
  }
  // A class with no scenarios is not "met" (nothing proven).
  for (const cls of ["C0", "C1", "C2"] as ConformanceClass[]) if (byClass[cls].total === 0) byClass[cls].met = false;

  const passRate = results.length ? passed / results.length : 0;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    passRate: Number(passRate.toFixed(3)),
    byCategory,
    byClass,
    metrics: { acceptanceRate: Number(passRate.toFixed(3)) },
    results,
  };
}
