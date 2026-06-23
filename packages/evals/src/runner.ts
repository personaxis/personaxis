import { SCENARIOS } from "./scenarios.js";
import type { Scenario, EvalReport, ScenarioResult } from "./types.js";

export async function runScenarios(scenarios: Scenario[] = SCENARIOS): Promise<EvalReport> {
  const results: ScenarioResult[] = [];
  for (const s of scenarios) {
    try {
      results.push(await s.run());
    } catch (e) {
      results.push({
        id: s.id,
        category: s.category,
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

  const passRate = results.length ? passed / results.length : 0;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    passRate: Number(passRate.toFixed(3)),
    byCategory,
    metrics: { acceptanceRate: Number(passRate.toFixed(3)) },
    results,
  };
}
