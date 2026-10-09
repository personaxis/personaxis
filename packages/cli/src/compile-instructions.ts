/**
 * Prompt templates for `personaxis compile` (forward: personaxis.md -> the compiled
 * document a model reads) and `personaxis decompile` (reverse: edited compiled doc ->
 * proposed personaxis.md).
 *
 * Both directions are written by a model: the prompt receives the full `personaxis.md`
 * (small, YAML + Markdown) and, forward, the reference document the code assembles from
 * it - never the contents of `memory/`, `references/`, `examples/`, `skills/`, or
 * `assets/`.
 *
 * These templates are consumed by the providers in `src/providers/` and are
 * intentionally provider-agnostic: any of `local | byok | agent` can
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

/** The "## " headings of a document, in order. */
function headingsOf(doc: string): string[] {
  return doc
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3).trim());
}

export interface WritePromptInput {
  /** The document the code assembles from the spec: the protected claims and current expressions. */
  reference: string;
  /** The spec, the source of truth. */
  personaxisMd: string;
  target: CompileTargetInfo;
  /** True when the reference folds applied self-edits over the spec. */
  overlaid?: boolean;
}

/**
 * The prompt for the forward direction: a model WRITES the compiled document.
 *
 * Until 2026-10-07 the code assembled the document and a model only polished its wording, and without a
 * model the assembly itself was written: duplicated traits, "Always" rules in the first person, affect
 * labels like "valence (low)". Now the assembly is the REFERENCE: the list of every protected claim and of
 * each trait's current expression, which `checkFaithfulness` holds the written document to. What the
 * prompt asks for is the 2026-10-07 reading of the research: the work first, traits only as they change
 * the work (irrelevant attributes cost up to 30 points, Principled Personas, EMNLP 2025), the reason for a
 * rule when the spec gives one, examples marked as examples and never invented, and a normal tone (current
 * models overreact to CRITICAL and capitalised MUST, Anthropic's prompting guidance).
 */
export function buildWritePrompt(input: WritePromptInput): string {
  return [
    `You write the compiled document for ${input.target.label}: the system prompt a language model reads to do`,
    `its work as this persona. You are given the persona's spec (the source of truth) and a REFERENCE the code`,
    `assembled from it, which lists every rule that must survive and how each trait expresses right now. The`,
    `reference is mechanical and clumsy; write the document a careful person would write from it.`,
    ``,
    `How to write it:`,
    `- In the second person ("You review...", "You never..."), opening with the reference's "# You are" line.`,
    `- The work first: what you do, how you do it, what you check, how you judge good output, what you do in`,
    `  specific situations. That is what changes the result.`,
    `- Traits and mood only as they change how the work is done, in plain behaviour. Never as labels, levels or`,
    `  numbers ("rigor (high)", "valence (low)"): attributes that do not bear on the task make a model worse.`,
    `  Keep every trait's current expression from the reference, merged where two say the same.`,
    `- Give the reason for a rule where the spec states one; never invent a reason or a fact.`,
    `- Voice: keep the spec's voice exemplars word for word, marked as examples. Write no new ones.`,
    `- A normal tone: no CRITICAL, no capitalised NEVER or ALWAYS, no exclamation marks. Each fact once.`,
    `- No numbers from the runtime state, no tables. Write in the language persona.voice.language names.`,
    ``,
    `What a check enforces (a document that fails it is sent back with the exact findings):`,
    `- Use only these "## " headings, spelled exactly so: ${headingsOf(input.reference).map((h) => `"${h}"`).join(", ")}.`,
    `  The work goes under "How you think" and "In specific situations" when the reference has them. A section`,
    `  may be dropped if nothing in it bears on the work, except the protected ones below; the order is yours.`,
    `- Under "Hard limits (never overridden)", "Staying in character", "What you always / never do" and "What`,
    `  is fixed, what can change", keep the content as "- " bullets: every bullet of the reference must survive`,
    `  (rephrased or merged, not weakened), and no bullet may say something the reference does not.`,
    `- Reproduce the "Memory & resources" bullets word for word.`,
    input.overlaid ? `- The reference already includes applied self-edits: where it and the spec differ, the reference wins.` : "",
    ``,
    `Output ONLY the document, without a code fence.`,
    section("REFERENCE (assembled from the spec; every protected bullet must survive)", input.reference),
    section("personaxis.md (the spec, source of truth)", input.personaxisMd),
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
