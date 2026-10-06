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
  /**
   * E81: for a task marked done, whether something the persona did backs it, which is a call that
   * succeeded after the task last changed. Absent on every other status, and on a task the loop wrote.
   */
  verified?: boolean;
  /** E81: the call that backs a verified done, by call id. One call backs one step. */
  evidence?: string[];
}

/** A task's id when the persona gave none: its text, folded, so resending the same step updates it. */
function idFor(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "task";
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

/**
 * One task as the model and the screen read it. A done that nothing backs is its own mark, with the reason
 * in words, so it cannot be read as finished.
 */
export function lineFor(task: Pick<SubTask, "text" | "status" | "verified">): string {
  if (task.status === "done" && task.verified === false) return `[?] ${task.text} (said done; nothing done backs it yet)`;
  const mark: Record<SubTaskStatus, string> = { done: "x", active: "~", blocked: "!", pending: " " };
  return `[${mark[task.status]}] ${task.text}`;
}

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
  /** E81: for each task, how many calls had succeeded when its status last changed. */
  private readonly since = new Map<string, number>();
  /** E81: the calls already backing a done step, which cannot back a second one. */
  private readonly claimed = new Set<string>();
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

  /**
   * E81: the persona's own list, replaced whole, where done needs something done.
   *
   * The rule is LongHorizon-Harness's: the state of the work changes only with facts from the
   * environment. `succeeded` is every call that succeeded in this run, in order. A task that becomes done
   * is verified when a call succeeded after the task last changed and is not already backing another step,
   * and that call is its evidence; a task the list names for the first time as done may be backed by any
   * such call in the run, because a persona that does the work first and writes the list after is not lying. Without a call it is kept as said done and
   * unverified: never silently accepted, and never refused, because refusing would teach the model to stop
   * reporting. A done that was unverified is checked again the next time it is sent.
   *
   * Returns the tasks marked done that nothing backs, so the caller can say so.
   */
  replaceTasks(list: ReadonlyArray<{ id?: string; text: string; status: SubTaskStatus }>, succeeded: readonly string[]): SubTask[] {
    const previous = new Map(this.subTasks.map((task) => [task.id, task]));
    const next: SubTask[] = [];
    const unbacked: SubTask[] = [];
    const seen = new Set<string>();
    for (const item of list) {
      const text = item.text.replace(/\s+/g, " ").trim();
      if (!text) continue;
      const id = item.id?.trim() || idFor(text);
      if (seen.has(id)) continue;
      seen.add(id);
      const before = previous.get(id);
      let task: SubTask;
      if (item.status !== "done") {
        task = { id, text, status: item.status };
      } else if (before?.status === "done" && before.verified !== false) {
        task = { ...before, text };
      } else {
        // One call backs one step. Without this, one file written and three steps marked done read as three
        // verified steps. The most recent call after the step last changed, not already backing another, is
        // the one taken.
        const backing = succeeded
          .slice(before ? (this.since.get(id) ?? 0) : 0)
          .filter((callId) => !this.claimed.has(callId))
          .at(-1);
        if (backing !== undefined) {
          this.claimed.add(backing);
          task = { id, text, status: "done", verified: true, evidence: [backing] };
        } else {
          task = { id, text, status: "done", verified: false };
          unbacked.push(task);
        }
      }
      // A step taken back from done gives its call back, so it can back the step that really used it.
      if (before?.status === "done" && item.status !== "done") for (const callId of before.evidence ?? []) this.claimed.delete(callId);
      if (!before || before.status !== item.status) this.since.set(id, succeeded.length);
      next.push(task);
    }
    this.subTasks = tail(next, this.limits.maxSubTasks);
    for (const id of [...this.since.keys()]) if (!seen.has(id)) this.since.delete(id);
    return unbacked;
  }

  /** E81: only the task list, for putting back in front of the model after a batch of calls. */
  renderTaskList(): string {
    if (this.subTasks.length === 0) return "";
    return ["Your task list (keep it current with update_tasks):", ...this.subTasks.map((task) => `  ${lineFor(task)}`)].join("\n");
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
      for (const s of this.subTasks) out.push(`  ${lineFor(s)}`);
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
