import type { PersonaData } from "../load.js";

export function compileSoulMd(data: PersonaData): string {
  const identity = data.identity as Record<string, string> | undefined;
  const character = data.character as Record<string, unknown> | undefined;
  const personality = data.personality as Record<string, unknown> | undefined;
  const cognition = data.cognition as Record<string, string> | undefined;
  const dv = (data.drives_values ?? data.drives) as Record<string, unknown> | undefined;
  const nsr = (data.normative_self_reg ?? data.constraints) as Record<string, unknown> | undefined;
  const persona = data.persona as Record<string, unknown> | undefined;

  const lines: string[] = [];

  lines.push("# SOUL");
  lines.push("");

  if (identity) {
    lines.push("## Identity");
    if (identity.name) lines.push(`name: ${identity.name}`);
    if (identity.role) lines.push(`role: ${identity.role}`);
    if (identity.purpose) lines.push(`purpose: ${identity.purpose}`);
    lines.push("");
  }

  if (persona) {
    lines.push("## Voice");
    if (persona.voice) lines.push(`${persona.voice}`);
    if (persona.presentation) lines.push(`\n${persona.presentation}`);
    lines.push("");
  }

  if (character) {
    const values = character.values as string[] | undefined;
    if (values?.length) {
      lines.push("## Core Values");
      values.forEach((v) => lines.push(`- ${v}`));
      lines.push("");
    }
    const principles = character.principles as string[] | undefined;
    if (principles?.length) {
      lines.push("## Principles");
      principles.forEach((p) => lines.push(`- ${p}`));
      lines.push("");
    }
  }

  if (personality) {
    lines.push("## Personality");
    if (personality.tone) lines.push(`Tone: ${personality.tone}`);
    if (personality.style) lines.push(`Style: ${personality.style}`);
    const traits = personality.traits as string[] | undefined;
    if (traits?.length) {
      lines.push("Traits:");
      traits.forEach((t) => lines.push(`  - ${t}`));
    }
    lines.push("");
  }

  if (cognition) {
    lines.push("## Reasoning");
    if (cognition.reasoning_style) lines.push(`${cognition.reasoning_style}`);
    if (cognition.handles_uncertainty) lines.push(`\nUnder uncertainty: ${cognition.handles_uncertainty}`);
    lines.push("");
  }

  if (dv) {
    lines.push("## Mission");
    if (dv.mission) lines.push(`${dv.mission}`);
    const goals = dv.goals as string[] | undefined;
    if (goals?.length) {
      lines.push("\nGoals:");
      goals.forEach((g) => lines.push(`  - ${g}`));
    }
    lines.push("");
  }

  if (nsr) {
    const refusals = (nsr.principledRefusals ?? (nsr as Record<string, unknown>).hard_limits) as string[] | undefined;
    if (refusals?.length) {
      lines.push("## Hard Limits");
      refusals.forEach((r) => lines.push(`- ${r}`));
      lines.push("");
    }
    const oos = nsr.out_of_scope as string[] | undefined;
    if (oos?.length) {
      lines.push("## Out of Scope");
      oos.forEach((o) => lines.push(`- ${o}`));
      lines.push("");
    }
  }

  return lines.join("\n").trim();
}
