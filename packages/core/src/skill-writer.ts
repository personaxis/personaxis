/**
 * Self-written skills (J.3, Voyager/Reflexion skill-library).
 *
 * When the agent solves something hard, the post-mortem (postmortem.ts) abstracts the
 * winning method into a reusable skill. That skill is a `.md` the agent will LOAD and
 * ACT on later, so it is code, not a note: before it is ever written, it must clear a
 * security floor (injection scan + danger review) that applies in EVERY mode, and only
 * then does governance decide where it lands:
 *   - locked      → blocked (no autonomous authorship at all);
 *   - suggesting  → queued to `skills/pending/` for a human to approve (never active);
 *   - autonomous  → written to `skills/` and registered in the ledger (active).
 *
 * The security floor runs first on purpose: a dangerous self-written skill is refused
 * with a security reason regardless of posture, so poisoning the evolution layer
 * (threat T14) never depends on the mode being permissive.
 *
 * Pure where it can be: `renderSkill` is deterministic given the draft (no timestamp
 * in the doc, so the content hash is stable), and the scanner/reviewer are injectable
 * so the gates are testable without disk.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { governQualitative, type ImprovementMode } from "./governance.js";
import { scanForInjection } from "./injection.js";
import { reviewSkillContent } from "./skill-review.js";
import { SkillLedger } from "./skill-lifecycle.js";

export interface SkillDraft {
  /** Skill name; sanitized to a safe kebab-case filename before use. */
  name: string;
  /** One-line description. */
  description: string;
  /** Task capabilities this skill matches (consumed by J.2 activeSkillsFor). */
  capabilities: string[];
  /** Tool names the methodology relies on (J.2 allowed_tools). */
  allowedTools: string[];
  /** The methodology itself (markdown). */
  body: string;
  /** Where the lesson came from (provenance line). */
  source?: string;
  /** Version tag; defaults to "1.0.0". */
  version?: string;
}

export interface WriteSkillOptions {
  /** Persona whose sibling `skills/` receives the skill. */
  personaPath: string;
  /** Governance posture (readMode of the persona). */
  mode: ImprovementMode;
  /** Injection scanner over the rendered content (default scanForInjection). */
  scan?: (text: string) => { verdict: "clean" | "suspicious" | "malicious" };
  /** Danger review over the rendered content (default reviewSkillContent). */
  review?: (content: string) => { verdict: "ok" | "review" | "danger" };
}

export type WriteOutcome = "written" | "queued" | "blocked";

export interface WriteResult {
  outcome: WriteOutcome;
  reason: string;
  /** Sanitized skill name actually used. */
  name: string;
  /** Content hash of the rendered skill (allowlisting), always computed. */
  hash: string;
  /** Where the `.md` landed (undefined when blocked). */
  path?: string;
}

/** A self-written skill name comes from an LLM: sanitize hard to a safe filename. */
export function safeSkillName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Deterministic render of a skill `.md` (no timestamp, so the hash is stable). */
export function renderSkill(draft: SkillDraft): string {
  const name = safeSkillName(draft.name);
  const fm = [
    "---",
    `name: ${name}`,
    `description: ${draft.description.replace(/\n+/g, " ").trim()}`,
    `capabilities: [${draft.capabilities.map((c) => c.trim()).filter(Boolean).join(", ")}]`,
    `allowed_tools: [${draft.allowedTools.map((t) => t.trim()).filter(Boolean).join(", ")}]`,
    `origin: self-written`,
    ...(draft.source ? [`source: ${draft.source.replace(/\n+/g, " ").trim()}`] : []),
    "---",
  ].join("\n");
  return `${fm}\n\n${draft.body.trim()}\n`;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Render, vet, and (if allowed) write a self-authored skill. The security floor is
 * unconditional; governance only ever runs on content that already passed it.
 */
export function writeSelfSkill(draft: SkillDraft, opts: WriteSkillOptions): WriteResult {
  const name = safeSkillName(draft.name);
  const content = renderSkill(draft);
  const hash = sha256(content);

  if (!name) {
    return { outcome: "blocked", reason: "empty skill name after sanitization", name, hash };
  }

  const scan = opts.scan ?? ((t: string) => scanForInjection(t));
  const review = opts.review ?? ((c: string) => reviewSkillContent(c));

  // Security floor, EVERY mode. A self-written skill is executable methodology.
  const s = scan(content);
  if (s.verdict === "malicious") {
    return { outcome: "blocked", reason: `injection scan: malicious`, name, hash };
  }
  const r = review(content);
  if (r.verdict === "danger") {
    return { outcome: "blocked", reason: `skill review: danger`, name, hash };
  }

  // Governance posture decides the destination (or blocks under locked).
  const gate = governQualitative(opts.mode);
  if (gate === "block") {
    return { outcome: "blocked", reason: "improvement_policy=locked", name, hash };
  }

  const baseDir = dirname(opts.personaPath);
  const dir = gate === "queue" ? join(baseDir, "skills", "pending") : join(baseDir, "skills");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.md`);
  writeFileSync(path, content, "utf-8");

  if (gate === "auto") {
    // Autonomous: the skill is active. Record its birth in the ledger (auditable).
    new SkillLedger(baseDir).register(name, draft.version ?? "1.0.0");
    return { outcome: "written", reason: "improvement_policy=autonomous", name, hash, path };
  }
  // suggesting: pending human approval, NOT registered/active until /review promotes it.
  return { outcome: "queued", reason: "improvement_policy=suggesting → pending human review", name, hash, path };
}
