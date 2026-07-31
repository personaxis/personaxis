/**
 * Structured task state (J.6): the agent's understanding of the CURRENT task, held as a
 * compact object OUTSIDE the message history so it cannot be lost when the transcript is
 * compacted. A long run degrades when the model has to re-derive "what am I doing and how
 * far am I" from 200 messages; instead it reasons over a small, always-current state that
 * is re-pinned into the context on every compaction.
 *
 * Pure and bounded: every list is capped so the state can never itself grow the context it
 * is meant to protect. `render()` produces the block that survives compaction (fed to
 * `compactMessages({ pinned })`).
 */

export type SubTaskStatus = "pending" | "active" | "done" | "blocked";

export interface SubTask {
  id: string;
  text: string;
  status: SubTaskStatus;
}

export interface TaskStateSnapshot {
  goal: string;
  plan: string[];
  decisions: string[];
  filesTouched: string[];
  subTasks: SubTask[];
  recentErrors: string[];
}

export interface TaskStateLimits {
  maxPlan?: number;
  maxDecisions?: number;
  maxFiles?: number;
  maxErrors?: number;
  maxSubTasks?: number;
}

const DEFAULT_LIMITS: Required<TaskStateLimits> = {
  maxPlan: 12,
  maxDecisions: 10,
  maxFiles: 20,
  maxErrors: 5,
  maxSubTasks: 20,
};

/** Keep the LAST n items (most recent), so the state reflects where the run IS now. */
function tail<T>(xs: T[], n: number): T[] {
  return xs.length > n ? xs.slice(xs.length - n) : xs;
}

export class TaskStateTracker {
  private goal = "";
  private plan: string[] = [];
  private decisions: string[] = [];
  private files: string[] = [];
  private errors: string[] = [];
  private subTasks: SubTask[] = [];
  private readonly limits: Required<TaskStateLimits>;

  constructor(init?: { goal?: string; limits?: TaskStateLimits }) {
    this.limits = { ...DEFAULT_LIMITS, ...(init?.limits ?? {}) };
    if (init?.goal) this.goal = init.goal.trim();
  }

  setGoal(goal: string): this {
    this.goal = goal.trim();
    return this;
  }

  /** Replace the plan wholesale (the planner re-plans; the state holds the CURRENT plan). */
  setPlan(steps: string[]): this {
    this.plan = tail(steps.map((s) => s.trim()).filter(Boolean), this.limits.maxPlan);
    return this;
  }

  recordDecision(text: string): this {
    const t = text.replace(/\s+/g, " ").trim();
    if (t) this.decisions = tail([...this.decisions, t], this.limits.maxDecisions);
    return this;
  }

  /** Note a file the run created/edited/read (deduped, most-recent kept). */
  noteFile(path: string): this {
    const p = path.trim();
    if (!p) return this;
    const without = this.files.filter((f) => f !== p);
    this.files = tail([...without, p], this.limits.maxFiles);
    return this;
  }

  noteError(text: string): this {
    const t = text.replace(/\s+/g, " ").trim();
    if (t) this.errors = tail([...this.errors, t], this.limits.maxErrors);
    return this;
  }

  /** Insert or update a sub-task by id. */
  upsertSubTask(id: string, text: string, status: SubTaskStatus): this {
    const i = this.subTasks.findIndex((s) => s.id === id);
    if (i >= 0) this.subTasks[i] = { id, text: text.trim(), status };
    else this.subTasks = tail([...this.subTasks, { id, text: text.trim(), status }], this.limits.maxSubTasks);
    return this;
  }

  snapshot(): TaskStateSnapshot {
    return {
      goal: this.goal,
      plan: [...this.plan],
      decisions: [...this.decisions],
      filesTouched: [...this.files],
      subTasks: this.subTasks.map((s) => ({ ...s })),
      recentErrors: [...this.errors],
    };
  }

  /** True when there is anything worth pinning (an empty tracker renders nothing). */
  get hasContent(): boolean {
    return Boolean(
      this.goal || this.plan.length || this.decisions.length || this.files.length || this.subTasks.length || this.errors.length,
    );
  }

  /**
   * The block that survives compaction. Only non-empty sections are emitted, so a
   * barely-started run pins a line, not a skeleton.
   */
  render(): string {
    if (!this.hasContent) return "";
    const out: string[] = ["# Task state (authoritative, survives compaction)"];
    if (this.goal) out.push(`Goal: ${this.goal}`);
    if (this.plan.length) {
      out.push("Plan:");
      for (const [i, step] of this.plan.entries()) out.push(`  ${i + 1}. ${step}`);
    }
    if (this.subTasks.length) {
      out.push("Sub-tasks:");
      const mark: Record<SubTaskStatus, string> = { done: "x", active: "~", blocked: "!", pending: " " };
      for (const s of this.subTasks) out.push(`  [${mark[s.status]}] ${s.text}`);
    }
    if (this.decisions.length) {
      out.push("Decisions:");
      for (const d of this.decisions) out.push(`  - ${d}`);
    }
    if (this.files.length) out.push(`Files touched: ${this.files.join(", ")}`);
    if (this.errors.length) {
      out.push("Recent errors:");
      for (const e of this.errors) out.push(`  - ${e}`);
    }
    return out.join("\n");
  }
}
