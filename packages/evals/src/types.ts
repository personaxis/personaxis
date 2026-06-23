export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

export interface ScenarioResult {
  id: string;
  category: string;
  description: string;
  passed: boolean;
  score: number; // fraction of checks passed
  checks: Check[];
  metrics?: Record<string, number>;
}

export interface Scenario {
  id: string;
  category: string;
  description: string;
  run(): Promise<ScenarioResult>;
}

export interface EvalReport {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  byCategory: Record<string, { passed: number; total: number }>;
  metrics: Record<string, number>;
  results: ScenarioResult[];
}
