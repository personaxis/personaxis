/**
 * Post-mortem → skill (J.3, Reflexion + Voyager).
 *
 * After a run, the agent reflects: was this a HARD-won success whose method is worth
 * keeping? If so, an injected LLM abstracts the winning approach into a reusable skill
 * draft, which is then written under the security floor + governance gate (skill-writer.ts).
 * The agent gets better by accumulating METHODOLOGY, not just episodic memory, and the
 * next similar task activates the skill (closing the loop with J.2).
 *
 * Two pure seams keep this testable and cheap: `shouldRunPostmortem` decides — with no
 * LLM — whether a run even merits reflection (so we never spend a turn on a trivial
 * chat), and the LLM `extract` + the `write` gate are both injected.
 */

import type { AgentOutcome } from "./memory.js";
import type { ImprovementMode } from "./governance.js";
import { writeSelfSkill, type SkillDraft, type WriteResult } from "./skill-writer.js";

/** What the loop knows about a finished run, enough to decide if reflection is worth it. */
export interface PostmortemTrigger {
  outcome: AgentOutcome;
  steps: number;
  /** Tool failures the run recovered from before it resolved. */
  failuresBeforeSuccess?: number;
  /** The model's initial confidence in [0,1], if known. */
  initialConfidence?: number;
}

/**
 * Is this run worth abstracting into a skill? Only successes qualify (a failure has no
 * method to promote), and only HARD ones: multi-step, or recovered from failures, or a
 * low-confidence start that still succeeded. A one-shot answer is skipped.
 */
export function shouldRunPostmortem(t: PostmortemTrigger): boolean {
  if (t.outcome !== "success") return false;
  if (t.steps >= 4) return true;
  if ((t.failuresBeforeSuccess ?? 0) >= 2) return true;
  if ((t.initialConfidence ?? 1) < 0.4 && t.steps >= 2) return true;
  return false;
}

/** The reusable lesson the LLM extracts from a run (null when there is nothing to keep). */
export interface Lesson {
  name: string;
  description: string;
  capabilities: string[];
  allowedTools: string[];
  body: string;
}

export interface PostmortemInput {
  task: string;
  /** The run transcript (already truncated by the caller). */
  transcript: string;
  outcome: AgentOutcome;
  /** Tool names the run actually used, seeds the skill's allowed_tools. */
  toolsUsed: string[];
}

export interface PostmortemDeps {
  /** LLM caller: abstract the run into a reusable lesson, or null if none. */
  extract: (input: PostmortemInput) => Promise<Lesson | null>;
  /** How the skill is written+gated (default: writeSelfSkill). Injected for tests. */
  write?: (draft: SkillDraft, opts: { personaPath: string; mode: ImprovementMode }) => WriteResult;
}

export interface PostmortemResult {
  ran: boolean;
  reason: string;
  lesson?: Lesson;
  write?: WriteResult;
}

/**
 * Run the post-mortem for a finished agent run: gate on the heuristic, extract the
 * lesson, then write it through governance. Best-effort by contract, the caller wraps
 * it so a reflection failure never crashes a run.
 */
export async function runPostmortem(
  trigger: PostmortemTrigger,
  input: PostmortemInput,
  opts: { personaPath: string; mode: ImprovementMode },
  deps: PostmortemDeps,
): Promise<PostmortemResult> {
  if (!shouldRunPostmortem(trigger)) {
    return { ran: false, reason: "trigger heuristic not met (trivial or failed run)" };
  }
  const lesson = await deps.extract(input);
  if (!lesson) {
    return { ran: true, reason: "no reusable lesson extracted" };
  }
  const write = (deps.write ?? writeSelfSkill)(
    {
      name: lesson.name,
      description: lesson.description,
      capabilities: lesson.capabilities,
      // Prefer what the lesson names; fall back to the tools the run actually used.
      allowedTools: lesson.allowedTools.length ? lesson.allowedTools : input.toolsUsed,
      body: lesson.body,
      source: `post-mortem: ${input.task.replace(/\n+/g, " ").slice(0, 80)}`,
    },
    { personaPath: opts.personaPath, mode: opts.mode },
  );
  return { ran: true, reason: `lesson → ${write.outcome}`, lesson, write };
}
