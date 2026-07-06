export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

/**
 * Spec conformance classes (SPEC.md conformance model):
 *   C0 Identity       — the persona is valid: schema + the 12 universals hold.
 *   C1 Governed State — clamp holds, the gate bounds, drift is capped.
 *   C2 Living Runtime — memory is tamper-evident, injection can't steer evolution,
 *                       budgets stop runaway, and the verifier catches an unverified finish.
 * Each higher class SUBSUMES the lower ones; a suite that passes C2 proves C0+C1 too.
 */
export type ConformanceClass = "C0" | "C1" | "C2";

export interface ScenarioResult {
  id: string;
  category: string;
  conformanceClass: ConformanceClass;
  description: string;
  passed: boolean;
  score: number; // fraction of checks passed
  checks: Check[];
  metrics?: Record<string, number>;
}

export interface Scenario {
  id: string;
  category: string;
  conformanceClass: ConformanceClass;
  description: string;
  run(): Promise<ScenarioResult>;
}

export interface EvalReport {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  byCategory: Record<string, { passed: number; total: number }>;
  /** Conformance-class rollup: a class is MET only when every scenario in it passes. */
  byClass: Record<ConformanceClass, { passed: number; total: number; met: boolean }>;
  metrics: Record<string, number>;
  results: ScenarioResult[];
}
