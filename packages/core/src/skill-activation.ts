/**
 * Dynamic skill → tool selection (J.2): the agent should not be shown every tool it has on every
 * task. A large catalog in the prompt costs tokens and, worse, invites the model to reach for a
 * tool it did not need (tool overload → hallucinated calls). Instead, the skills relevant to the
 * task decide which tools are on the table: a filesystem task exposes the filesystem tools plus a
 * small base, not the shell, the network, and every mounted MCP tool.
 *
 * Pure: this decides the SUBSET from the task, the catalog, and the active skills. Resolving which
 * skills a persona has (and their `allowed_tools`) is the caller's job; wiring it into the loop is
 * `agent.ts`. Subsetting only ever NARROWS when a skill actually matches the task; a task no skill
 * covers keeps the full catalog, so nothing is ever hidden without a reason.
 */

import type { ToolSpec, ToolCategory } from "./tools/registry.js";
import { FINISH_TOOL } from "./tools/registry.js";

/** A skill that could apply to a task: what it is good at, and which tools it needs. */
export interface ActiveSkill {
  name: string;
  capabilities: string[];
  /** Tool names this skill's methodology relies on. */
  allowedTools: string[];
}

const STOPWORDS = new Set([
  "the", "a", "an", "to", "of", "and", "or", "in", "on", "for", "with", "my", "me", "i", "is", "it",
  "this", "that", "your", "you", "please", "can", "will", "would", "should", "do", "make", "get",
]);

/** Lowercase, de-duplicated, meaningful tokens of a task, for matching skill capabilities. */
export function taskTokens(task: string): string[] {
  const words = task.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  return [...new Set(words)].filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/** Skills whose capabilities overlap the task, most-relevant first (empty if none match). */
export function activeSkillsFor(task: string, skills: ActiveSkill[]): ActiveSkill[] {
  const tokens = new Set(taskTokens(task));
  return skills
    .map((s) => ({ s, hits: s.capabilities.filter((c) => tokens.has(c.toLowerCase())).length }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .map((x) => x.s);
}

export interface SubsetOptions {
  /** Tool categories always available, regardless of skills. Default: `meta` (so `finish` stays). */
  alwaysCategories?: ToolCategory[];
  /** Tool names always available. Default: `finish`. */
  alwaysNames?: string[];
}

/**
 * The tools to expose for a task: the base set plus the tools the active skills need. When no
 * skill matches the task, the FULL catalog is returned unchanged.
 */
export function selectActiveTools(
  task: string,
  allTools: ToolSpec[],
  skills: ActiveSkill[],
  opts: SubsetOptions = {},
): ToolSpec[] {
  const active = activeSkillsFor(task, skills);
  if (active.length === 0) return allTools;

  const allowed = new Set<string>(opts.alwaysNames ?? [FINISH_TOOL]);
  for (const s of active) for (const t of s.allowedTools) allowed.add(t);
  const alwaysCats = new Set<ToolCategory>(opts.alwaysCategories ?? ["meta"]);

  // An UNCATEGORIZED tool (e.g. the persona's own memory tools) is base: it is not part of the
  // category subsetting and is always available. Categorized tools are narrowed to the active
  // skills' needs plus the always-categories.
  return allTools.filter((t) => t.category === undefined || allowed.has(t.name) || alwaysCats.has(t.category));
}
