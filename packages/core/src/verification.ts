/**
 * Objective verification (v0.9, spec `verification`): the maker≠checker split.
 *
 * The loop-engineering research is blunt: the #1 reason loops fail is "a second
 * agent asked to review without an objective gate, two optimists agreeing", and
 * "the model that wrote the code is too nice grading its own homework". So the
 * agent that did the work NEVER decides done; an INDEPENDENT verifier does, and
 * where possible it is deterministic (a command's exit code, a predicate) rather
 * than an opinion. Four gate types cover coding AND non-coding domains:
 *   - command  : run a shell check (test/build/lint); pass = exit 0
 *   - predicate: assert over the agent's output (regex | contains | jsonpath)
 *   - llm_judge: a separate model judges done/criteria → {pass, reason}
 *   - rubric   : a separate model scores weighted dimensions → score ≥ threshold
 *
 * Reuses the consensus/quorum vocabulary from self-evolution (VerifierResult).
 */

import { executeCommand } from "./tools/exec.js";
import { DEFAULT_POLICY, type Policy } from "./sandbox.js";
import type { VerifierResult, ConsensusResult } from "./self-evolution.js";

export type VerificationMode = "off" | "advisory" | "blocking";
export type OnFail = "retry" | "skip" | "stop";

export interface VerificationGate {
  type: "command" | "predicate" | "llm_judge" | "rubric";
  name?: string;
  // command
  run?: string;
  timeout_ms?: number;
  // predicate
  kind?: "regex" | "jsonpath" | "contains";
  expr?: string;
  // llm_judge / rubric
  criteria?: string;
  model?: string;
  // rubric
  dimensions?: Array<{ name: string; weight: number; criteria?: string }>;
  threshold?: number;
}

export interface VerificationConfig {
  mode: VerificationMode;
  quorum: "all" | "majority" | number;
  onFail: OnFail;
  maxRetries: number;
  gates: VerificationGate[];
}

export const DEFAULT_VERIFICATION: VerificationConfig = {
  mode: "off",
  quorum: "all",
  onFail: "retry",
  maxRetries: 1,
  gates: [],
};

export interface VerificationContext {
  task: string;
  /** The agent's final output / summary. */
  output: string;
  /** Full transcript text (for judges that need the trail). */
  transcript?: string;
}

/** Optional LLM access for llm_judge / rubric gates (constrained JSON). */
export interface JudgeConfig {
  endpoint: string;
  model: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export interface VerifyOptions {
  policy?: Policy;
  judge?: JudgeConfig;
}

export function readVerification(frontmatter: Record<string, unknown>): VerificationConfig {
  const v = frontmatter.verification as Partial<Record<string, unknown>> | undefined;
  if (!v) return { ...DEFAULT_VERIFICATION };
  const mode = v.mode === "advisory" || v.mode === "blocking" ? v.mode : "off";
  const quorum =
    v.quorum === "majority" || (typeof v.quorum === "number" && v.quorum >= 1) ? (v.quorum as "majority" | number) : "all";
  const onFail = v.on_fail === "skip" || v.on_fail === "stop" ? v.on_fail : "retry";
  const maxRetries = typeof v.max_retries === "number" && v.max_retries >= 0 ? v.max_retries : 1;
  const gates = Array.isArray(v.gates) ? (v.gates as VerificationGate[]) : [];
  return { mode, quorum, onFail, maxRetries, gates };
}

function resolveQuorum(n: number, quorum: VerificationConfig["quorum"]): number {
  if (quorum === "all") return n;
  if (quorum === "majority") return Math.floor(n / 2) + 1;
  return Math.min(Math.max(1, quorum), n);
}

// ── Individual gate verifiers ────────────────────────────────────────────────

async function verifyCommand(gate: VerificationGate, policy: Policy): Promise<VerifierResult> {
  const name = gate.name ?? `command:${(gate.run ?? "").slice(0, 24)}`;
  if (!gate.run) return { verifier: name, pass: false, reason: "no command specified" };
  const r = await executeCommand(gate.run, policy, { timeoutMs: gate.timeout_ms });
  return {
    verifier: name,
    pass: r.ok,
    reason: r.ok ? `exit 0` : `exit ${r.code}${r.timedOut ? " (timeout)" : ""}: ${(r.stderr || r.stdout).split("\n")[0].slice(0, 120)}`,
  };
}

function verifyPredicate(gate: VerificationGate, output: string): VerifierResult {
  const name = gate.name ?? `predicate:${gate.kind}`;
  const expr = gate.expr ?? "";
  let pass = false;
  let reason = "";
  try {
    if (gate.kind === "regex") {
      pass = new RegExp(expr).test(output);
      reason = pass ? "regex matched" : "regex did not match";
    } else if (gate.kind === "contains") {
      pass = output.includes(expr);
      reason = pass ? "substring present" : "substring absent";
    } else if (gate.kind === "jsonpath") {
      const val = jsonPath(output, expr);
      pass = val !== undefined && val !== null && val !== false;
      reason = pass ? `path ${expr} present/truthy` : `path ${expr} missing/falsy`;
    } else {
      reason = `unknown predicate kind '${gate.kind}'`;
    }
  } catch (e) {
    reason = `predicate error: ${(e as Error).message}`;
  }
  return { verifier: name, pass, reason };
}

/** Minimal `$.a.b[0]` resolver over JSON.parse(output). Best-effort, dependency-free. */
function jsonPath(output: string, path: string): unknown {
  let obj: unknown;
  try {
    obj = JSON.parse(output);
  } catch {
    const m = output.match(/\{[\s\S]*\}/);
    if (!m) return undefined;
    try {
      obj = JSON.parse(m[0]);
    } catch {
      return undefined;
    }
  }
  const parts = path.replace(/^\$\.?/, "").split(/[.\[\]]+/).filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

async function judgeJson(judge: JudgeConfig, system: string, user: string): Promise<Record<string, unknown> | null> {
  const fetchImpl = judge.fetchImpl ?? fetch;
  const res = await fetchImpl(`${judge.endpoint.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(judge.apiKey ? { authorization: `Bearer ${judge.apiKey}` } : {}) },
    body: JSON.stringify({
      model: judge.model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: 0,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`judge HTTP ${res.status}`);
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = json.choices?.[0]?.message?.content ?? "{}";
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    const m = content.match(/\{[\s\S]*\}/);
    return m ? (JSON.parse(m[0]) as Record<string, unknown>) : null;
  }
}

async function verifyLlmJudge(gate: VerificationGate, ctx: VerificationContext, judge?: JudgeConfig): Promise<VerifierResult> {
  const name = gate.name ?? "llm_judge";
  if (!judge) return { verifier: name, pass: true, reason: "skipped (no judge model configured)" };
  try {
    const out = await judgeJson(
      { ...judge, model: gate.model ?? judge.model },
      "You are an INDEPENDENT verifier. You did not do the work. Decide strictly whether the result meets the criteria. Output JSON {\"pass\": boolean, \"reason\": string}.",
      `# Criteria\n${gate.criteria ?? "Task fully and correctly completed."}\n\n# Task\n${ctx.task}\n\n# Result\n${ctx.output.slice(0, 4000)}`,
    );
    const pass = out?.pass === true;
    return { verifier: name, pass, reason: typeof out?.reason === "string" ? out.reason.slice(0, 160) : pass ? "met" : "not met" };
  } catch (e) {
    return { verifier: name, pass: false, reason: `judge error: ${(e as Error).message}` };
  }
}

async function verifyRubric(gate: VerificationGate, ctx: VerificationContext, judge?: JudgeConfig): Promise<VerifierResult> {
  const name = gate.name ?? "rubric";
  const dims = gate.dimensions ?? [];
  const threshold = typeof gate.threshold === "number" ? gate.threshold : 0.7;
  if (!judge) return { verifier: name, pass: true, reason: "skipped (no judge model configured)" };
  try {
    const out = await judgeJson(
      { ...judge, model: gate.model ?? judge.model },
      "You are an INDEPENDENT grader. Score each dimension 0..1. Output JSON {\"scores\": {<dim>: number}, \"notes\": string}.",
      `# Dimensions\n${dims.map((d) => `- ${d.name} (weight ${d.weight})${d.criteria ? ": " + d.criteria : ""}`).join("\n")}\n\n# Criteria\n${gate.criteria ?? ""}\n\n# Task\n${ctx.task}\n\n# Result\n${ctx.output.slice(0, 4000)}`,
    );
    const scores = (out?.scores ?? {}) as Record<string, number>;
    const totalW = dims.reduce((s, d) => s + d.weight, 0) || 1;
    const agg = dims.reduce((s, d) => s + (Number(scores[d.name]) || 0) * d.weight, 0) / totalW;
    const pass = agg >= threshold;
    return { verifier: name, pass, reason: `score ${agg.toFixed(2)} ${pass ? "≥" : "<"} threshold ${threshold}` };
  } catch (e) {
    return { verifier: name, pass: false, reason: `rubric error: ${(e as Error).message}` };
  }
}

/** Run all gates and apply the quorum. Returns a ConsensusResult (reused shape). */
export async function runVerification(
  config: VerificationConfig,
  ctx: VerificationContext,
  opts: VerifyOptions = {},
): Promise<ConsensusResult> {
  const policy = opts.policy ?? DEFAULT_POLICY;
  const results: VerifierResult[] = [];
  for (const gate of config.gates) {
    switch (gate.type) {
      case "command":
        results.push(await verifyCommand(gate, policy));
        break;
      case "predicate":
        results.push(verifyPredicate(gate, ctx.output));
        break;
      case "llm_judge":
        results.push(await verifyLlmJudge(gate, ctx, opts.judge));
        break;
      case "rubric":
        results.push(await verifyRubric(gate, ctx, opts.judge));
        break;
      default:
        results.push({ verifier: `unknown:${(gate as { type?: string }).type}`, pass: false, reason: "unknown gate type" });
    }
  }
  const quorum = resolveQuorum(results.length || 1, config.quorum);
  const passes = results.filter((r) => r.pass).length;
  return { passed: results.length === 0 ? true : passes >= quorum, results, quorum, passes };
}
