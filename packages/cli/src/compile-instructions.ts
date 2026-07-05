/**
 * Prompt templates for `personaxis compile` (forward: personaxis.md -> compiled
 * doc) and `personaxis decompile` (reverse: edited compiled doc -> proposed
 * personaxis.md).
 *
 * Both directions are LLM-based but lightweight: the prompt receives the full
 * `personaxis.md` (small, YAML + Markdown), `policy.yaml`/`state.json`, and a
 * capped resource manifest (see `resource-manifest.ts`) - never the contents
 * of `memory/`, `references/`, `examples/`, `skills/`, or `assets/`.
 *
 * These templates are consumed by the providers in `src/providers/` and are
 * intentionally provider-agnostic: any of `local | byok | agent | remote` can
 * pass the resulting string to a chat-completion call.
 */

export interface CompileTargetInfo {
  /** e.g. "repo-root PERSONA.md (root mode)" or "Claude Code subagent .claude/agents/frontend-expert.md" */
  label: string;
  /** Relative path the compiled document will be written to. */
  outputPath: string;
  /** True when compiling a `.personaxis/personas/<slug>/` subagent rather than the root persona. */
  isSubagent: boolean;
  slug?: string;
}

export interface CompilePromptInput {
  personaxisMd: string;
  policyYaml?: string;
  stateJson?: string;
  resourceManifest: string;
  target: CompileTargetInfo;
  /** Applied governed self-edits (dot-path -> value). Authoritative overrides over the
   * raw spec, so a recompile reflects what the persona has evolved into. */
  appliedOverlay?: Record<string, unknown>;
}

export interface DecompilePromptInput {
  currentPersonaxisMd: string;
  editedCompiledMd: string;
  policyYaml?: string;
  stateJson?: string;
  resourceManifest: string;
  target: CompileTargetInfo;
}

function section(title: string, body: string | undefined): string {
  if (!body || !body.trim()) return "";
  return `\n## ${title}\n\n${body.trim()}\n`;
}

/**
 * Builds the prompt for the forward direction: `personaxis.md` (10-layer
 * quantitative spec) -> a compiled, qualitative document following the
 * section contract in `PERSONA_template.md`.
 */
export function buildCompilePrompt(input: CompilePromptInput): string {
  const { target } = input;

  const subagentNote = target.isSubagent
    ? `This is a SUBAGENT compile for slug "${target.slug}". The output must start with a YAML ` +
      `frontmatter block containing only "name" and "description" (no other fields), followed by ` +
      `the same body sections as a root PERSONA.md. The "description" must be a single line ` +
      `summarizing when a coding agent should invoke this subagent.`
    : `This is a ROOT compile. The output is a plain Markdown document with NO YAML frontmatter - ` +
      `it is read directly by a coding agent (Claude Code, Codex) as the repo-wide behavioral baseline.`;

  return [
    `You are the personaxis compiler. Compile the quantitative persona spec below into ${target.label}.`,
    ``,
    subagentNote,
    ``,
    `This document is a PERSONA-PROMPTING artifact, not a profile: its job is to make a language ` +
      `model ADOPT and STAY IN this persona. Apply these evidence-backed devices (see ` +
      `docs/PERSONA_PROMPTING.md): write the ENTIRE document in the SECOND PERSON ("You are…", ` +
      `"You always…") as direct role adoption; open with a one-line "You are <name>…" statement; ` +
      `give a tight CHARACTER CARD; include 2-4 few-shot VOICE EXEMPLARS; use concrete behavioral ` +
      `ANCHORS (Always/Never) with examples; write SCENE CONTRACTS that connect a situation to the ` +
      `behavior and concrete actions; separate STABLE / EVOLVING / SITUATIONAL traits; and add ` +
      `anti-break-character guardrails.`,
    ``,
    `Follow the section order in PERSONA_template.md: "You are <name>" opener, Who you are, How you ` +
      `speak (+ voice exemplars), What you always / never do, In specific situations (scene ` +
      `contracts), How you think, What is fixed / what can change, Hard limits (never overridden), ` +
      `Staying in character, Memory & resources, Self-improvement.`,
    ``,
    `When the spec has persona-prompting source fields (v1.0: inside the "persona" layer; legacy `
      + `0.10 documents: a top-level "persona_prompting" block), use them directly: address.you_are for the ` +
      `opener, voice_exemplars for "How you speak", scene_contracts for "In specific situations", ` +
      `behavioral_anchors for Always/Never, break_character_guardrails for "Staying in character", ` +
      `and consistency for "What is fixed / what can change". When a field is absent, DERIVE that ` +
      `section faithfully from the quantitative layers. Do not invent facts, rules, or limits not ` +
      `present in or directly implied by the spec.`,
    ``,
    `Two hard rules: (1) "Hard limits" must reproduce the safety universals ` +
      `(reflexive_self_regulation.hard_limits + persona.constraints), and "Staying in character" must ` +
      `explicitly state it NEVER overrides those limits. (2) The "Memory & resources" section must ` +
      `reproduce the resource manifest below verbatim (bullet list), with paths relative to ` +
      `${target.outputPath} (e.g. "${target.isSubagent ? "./" : "./.personaxis/"}memory.md" — a sub-persona's ` +
      `compiled PERSONA.md lives INSIDE its own folder, so its resources are "./"; the root PERSONA.md ` +
      `lives at the repo root, so its resources are "./.personaxis/").`,
    ``,
    input.appliedOverlay && Object.keys(input.appliedOverlay).length > 0
      ? `Applied self-edits OVERRIDE the spec below: where a dot-path here conflicts with the spec, use THIS value (the persona has governed-evolved into it).`
      : "",
    `Faithfulness & density (avoid the two failure modes — generic filler and redundancy):`,
    `- ONE SOURCE PER FACT: state each fact, rule, trait, or limit in exactly ONE section. The only ` +
      `permitted restatement is a hard limit (it lives in "Hard limits" and is REFERENCED, not repeated, ` +
      `in "Staying in character"). Do not echo the same trait/value across multiple sections.`,
    `- CONCENTRATE the whole spec: every meaningful layer field (character virtues, values_and_drives, ` +
      `cognition/uncertainty policy, metacognition, affect tendencies, memory posture) must surface in ` +
      `its natural section — do not drop fields, but do not pad. Prefer the persona's CONCRETE language ` +
      `over restating the YAML; never quote field names or YAML verbatim.`,
    `- NO NUMERIC STATE: never include runtime numbers, trait/affect tables, sigil seeds, or a ` +
      `"live state" block. The compiled document is purely qualitative; state lives in state.json.`,
    `Output ONLY the compiled document. Do not wrap it in a code block.`,
    section("personaxis.md (quantitative spec + persona_prompting source, source of truth)", input.personaxisMd),
    input.appliedOverlay && Object.keys(input.appliedOverlay).length > 0
      ? section("Applied self-edits (dot-path -> value, AUTHORITATIVE overrides)", JSON.stringify(input.appliedOverlay, null, 2))
      : "",
    section("policy.yaml (operational policy - reference only, do not restate verbatim)", input.policyYaml),
    section("state.json (current runtime state - reference only)", input.stateJson),
    section("Resource manifest (paths only, never file contents)", input.resourceManifest),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export interface PolishPromptInput {
  /** The deterministic stage-1 artifact — the GROUND TRUTH to rephrase. */
  assembled: string;
  /** The quantitative spec, for register/voice reference only (not new facts). */
  personaxisMd: string;
  target: CompileTargetInfo;
}

/**
 * F3.1 stage 2 — the LLM POLISH prompt. Unlike the from-scratch compile prompt,
 * polish receives the already-assembled canonical document and is constrained to
 * REPHRASE it for fluency and register: it may reorder within a section, merge
 * choppy bullets into prose, and tune voice — but it may NOT add, drop, or
 * change any claim (virtue, rule, limit, anchor, consistency dimension). The
 * deterministic faithfulness check (core `checkFaithfulness`) rejects a polish
 * that violates this, and the caller falls back to the assembled document.
 */
export function buildPolishPrompt(input: PolishPromptInput): string {
  return [
    `You are the personaxis compiler's POLISH stage for ${input.target.label}.`,
    ``,
    `You are given an already-correct, deterministically-assembled persona document. Your ONLY job ` +
      `is to make it read fluently and in a consistent SECOND-PERSON voice ("You are…", "You always…") ` +
      `— a persona-prompting artifact a language model adopts.`,
    ``,
    `HARD CONSTRAINTS (a downstream deterministic check enforces these and will REJECT your output):`,
    `- Do NOT add any fact, rule, virtue, limit, behavioral anchor, or consistency dimension that is ` +
      `not already in the assembled document. Inventing content is the primary failure mode.`,
    `- Do NOT drop or weaken any hard limit, "Always/Never" anchor, or stay-in-character rule. Every ` +
      `bullet under "Hard limits", "Staying in character", "What you always / never do", and "What is ` +
      `fixed, what can change" must survive (you may rephrase it, not remove it).`,
    `- Keep the same "## " section headings and their order.`,
    `- Never include runtime numbers, trait/affect tables, or a live-state block.`,
    `- Reproduce the "Memory & resources" bullets verbatim.`,
    ``,
    `You MAY: smooth choppy bullets into readable prose, fix grammar, unify the second-person voice, ` +
      `and tighten wording. When in doubt, change less.`,
    ``,
    `Output ONLY the polished document. Do not wrap it in a code block.`,
    section("Assembled document (GROUND TRUTH — rephrase, do not alter meaning)", input.assembled),
    section("personaxis.md (register/voice reference only — introduces NO new facts)", input.personaxisMd),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * Builds the prompt for the reverse direction: a hand-edited compiled
 * document -> a proposed `personaxis.md`, preserving fields that the edit did
 * not touch. The caller MUST validate the result before writing it.
 */
export function buildDecompilePrompt(input: DecompilePromptInput): string {
  const { target } = input;

  return [
    `You are the personaxis decompiler. A human hand-edited the compiled document for ${target.label}. ` +
      `Propose an updated personaxis.md (10-layer quantitative spec) that reflects the intent of the ` +
      `edits, while preserving the YAML structure, field names, and any fields the edit did not affect.`,
    ``,
    `Rules:`,
    `- Keep "spec_version", "metadata", and all layer keys present in the current personaxis.md.`,
    `- Only change fields whose qualitative description in the compiled document changed meaningfully.`,
    `- Do not remove governance, security, or runtime_artifacts blocks unless the edit explicitly removes ` +
      `the corresponding behavior.`,
    `- If the edit introduces a constraint, virtue, value, or limit that has no corresponding field, add ` +
      `it to the most specific existing layer rather than inventing a new top-level block.`,
    `- Map persona-prompting edits to their source fields (v1.0: inside the "persona" layer; legacy: `
      + `the "persona_prompting" block): changes to "How you speak" voice ` +
      `samples -> voice_exemplars; "In specific situations" -> scene_contracts; Always/Never -> ` +
      `behavioral_anchors; "Staying in character" -> self_regulation.hard_limits (v1.0) or `
      + `break_character_guardrails (legacy); fixed/evolving/` +
      `situational -> consistency. Never weaken a safety universal or a hard limit via these edits.`,
    `- Output ONLY the full updated personaxis.md (YAML frontmatter + Markdown body), starting with "---".`,
    section("Current personaxis.md (quantitative spec, before edit)", input.currentPersonaxisMd),
    section(`Edited ${target.outputPath} (compiled document, after hand-edit)`, input.editedCompiledMd),
    section("policy.yaml (operational policy - reference only)", input.policyYaml),
    section("state.json (current runtime state - reference only)", input.stateJson),
    section("Resource manifest (paths only, never file contents)", input.resourceManifest),
  ]
    .filter((line) => line !== "")
    .join("\n");
}
