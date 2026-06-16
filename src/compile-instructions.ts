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
    `You are the personaxis compiler. Translate the quantitative persona spec below into ${target.label}.`,
    ``,
    subagentNote,
    ``,
    `Follow the section contract documented in PERSONA_template.md: Identity & Purpose, Character ` +
      `(Always / Never), Personality & Voice, Values, How You Think, Limits, Self-Improvement, and ` +
      `Resources. Write in clear prose - this document is read directly by a coding agent, not parsed ` +
      `as data. Do not invent facts, rules, or constraints that are not present in or directly implied ` +
      `by the spec below.`,
    ``,
    `The final "Resources" section must reproduce the resource manifest given below verbatim (as a ` +
      `bullet list), with paths rewritten relative to ${target.outputPath} ` +
      `(e.g. "${target.isSubagent ? `./.personaxis/personas/${target.slug}/` : "./.personaxis/"}memory.md").`,
    ``,
    `Output ONLY the compiled document. Do not wrap it in a code block.`,
    section("personaxis.md (quantitative spec, source of truth)", input.personaxisMd),
    section("policy.yaml (operational policy - reference only, do not restate verbatim)", input.policyYaml),
    section("state.json (current runtime state - reference only)", input.stateJson),
    section("Resource manifest (paths only, never file contents)", input.resourceManifest),
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
