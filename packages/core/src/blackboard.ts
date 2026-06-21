/**
 * Blackboard multi-persona orchestration (F7 — plan/07-orchestration).
 *
 * The overseer doesn't hard-wire which persona does what. It posts a task to a
 * shared blackboard; personas *volunteer* ranked by how well their declared
 * capabilities match the task (Salemi et al., 2025 blackboard; the puppeteer
 * orchestrator of Dang et al., 2025 picks among volunteers). This scales to a
 * heterogeneous pool without a central registry of who-can-do-what.
 *
 * Everything is auditable: post → solicit (ranked) → assign → contribute → resolve,
 * each an event on the board. The actual "work" is a pluggable worker (an LLM-backed
 * loop in production; a stub in tests), so the orchestration is verifiable on its own.
 */

import type { PersonaFrontmatter } from "./persona.js";

const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "for", "in", "on", "with", "run", "the", "this", "that", "make", "do"]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s/_-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/** Capability tokens for a persona, from its identity layer. */
export function extractCapabilities(fm: PersonaFrontmatter): string[] {
  const id = fm.identity as
    | {
        system_identity?: { purpose?: string; allowed_domains?: unknown };
        role_identity?: { primary_role?: string } | string;
        narrative_identity?: { self_concept?: string };
      }
    | undefined;
  const tokens = new Set<string>();
  const si = id?.system_identity;
  if (si?.purpose) tokenize(si.purpose).forEach((t) => tokens.add(t));
  if (Array.isArray(si?.allowed_domains)) {
    for (const d of si.allowed_domains as unknown[]) if (typeof d === "string") tokenize(d).forEach((t) => tokens.add(t));
  }
  const role = id?.role_identity;
  if (typeof role === "string") tokenize(role).forEach((t) => tokens.add(t));
  else if (role?.primary_role) tokenize(role.primary_role).forEach((t) => tokens.add(t));
  return [...tokens];
}

export interface Agent {
  id: string;
  capabilities: string[];
}

export interface Volunteer {
  id: string;
  score: number;
  matched: string[];
}

export type TaskStatus = "open" | "assigned" | "resolved";

export interface Contribution {
  agentId: string;
  content: string;
  ts: string;
}

export interface Task {
  id: string;
  description: string;
  tokens: string[];
  status: TaskStatus;
  assignedTo?: string;
  contributions: Contribution[];
  result?: string;
}

export interface BoardEvent {
  ts: string;
  kind: "post" | "assign" | "contribute" | "resolve";
  taskId: string;
  detail: string;
}

/** Score how well an agent matches a task (Jaccard-like, recall-weighted). */
export function matchScore(taskTokens: string[], capabilities: string[]): { score: number; matched: string[] } {
  if (taskTokens.length === 0) return { score: 0, matched: [] };
  const caps = new Set(capabilities);
  const matched = taskTokens.filter((t) => caps.has(t));
  // recall over the task's needs, lightly boosted by capability breadth coverage
  const score = matched.length / taskTokens.length;
  return { score: Number(score.toFixed(3)), matched };
}

export class Blackboard {
  private tasks = new Map<string, Task>();
  readonly log: BoardEvent[] = [];
  private seq = 0;

  post(description: string): Task {
    const id = `t${++this.seq}`;
    const task: Task = { id, description, tokens: tokenize(description), status: "open", contributions: [] };
    this.tasks.set(id, task);
    this.event("post", id, description);
    return task;
  }

  /** Rank the agents who could take this task (highest score first, score>0). */
  solicit(taskId: string, agents: Agent[]): Volunteer[] {
    const task = this.require(taskId);
    return agents
      .map((a) => {
        const { score, matched } = matchScore(task.tokens, a.capabilities);
        return { id: a.id, score, matched };
      })
      .filter((v) => v.score > 0)
      .sort((a, b) => b.score - a.score);
  }

  /** Assign to a specific agent, or auto-assign the top volunteer. */
  assign(taskId: string, agents: Agent[], agentId?: string): Volunteer | null {
    const task = this.require(taskId);
    const ranked = this.solicit(taskId, agents);
    const chosen = agentId ? ranked.find((v) => v.id === agentId) : ranked[0];
    if (!chosen) return null;
    task.status = "assigned";
    task.assignedTo = chosen.id;
    this.event("assign", taskId, `${chosen.id} (score ${chosen.score})`);
    return chosen;
  }

  contribute(taskId: string, agentId: string, content: string): void {
    const task = this.require(taskId);
    task.contributions.push({ agentId, content, ts: new Date().toISOString() });
    this.event("contribute", taskId, `${agentId}: ${content.slice(0, 60)}`);
  }

  resolve(taskId: string, result: string): void {
    const task = this.require(taskId);
    task.status = "resolved";
    task.result = result;
    this.event("resolve", taskId, result.slice(0, 60));
  }

  get(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }
  all(): Task[] {
    return [...this.tasks.values()];
  }

  private require(taskId: string): Task {
    const t = this.tasks.get(taskId);
    if (!t) throw new Error(`no task ${taskId}`);
    return t;
  }
  private event(kind: BoardEvent["kind"], taskId: string, detail: string): void {
    this.log.push({ ts: new Date().toISOString(), kind, taskId, detail });
  }
}

export interface OrchestrateOptions {
  /** Pluggable worker: in production an LLM-backed loop; default a stub. */
  worker?: (agent: Agent, task: Task) => Promise<string> | string;
}

export interface OrchestrateResult {
  task: Task;
  volunteers: Volunteer[];
  assigned: Volunteer | null;
  contribution?: string;
}

/**
 * Run one full blackboard cycle for a task over a pool of agents (puppeteer-style:
 * solicit volunteers, assign the best, have it contribute, resolve).
 */
export async function orchestrate(
  board: Blackboard,
  description: string,
  agents: Agent[],
  opts: OrchestrateOptions = {},
): Promise<OrchestrateResult> {
  const task = board.post(description);
  const volunteers = board.solicit(task.id, agents);
  const assigned = board.assign(task.id, agents);
  if (!assigned) return { task: board.get(task.id)!, volunteers, assigned: null };

  const worker =
    opts.worker ??
    ((a: Agent, t: Task) => `${a.id} handled "${t.description}" (matched: ${matchScore(t.tokens, a.capabilities).matched.join(", ")})`);
  const agent = agents.find((a) => a.id === assigned.id)!;
  const contribution = await worker(agent, task);
  board.contribute(task.id, assigned.id, contribution);
  board.resolve(task.id, contribution);
  return { task: board.get(task.id)!, volunteers, assigned, contribution };
}
