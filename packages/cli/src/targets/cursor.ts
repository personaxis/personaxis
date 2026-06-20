import type { PersonaData } from "../load.js";

export function compileCursor(data: PersonaData): string {
  const identity = data.identity as Record<string, string> | undefined;
  const character = data.character as Record<string, unknown> | undefined;
  const personality = data.personality as Record<string, unknown> | undefined;
  const nsr = (data.normative_self_reg ?? data.constraints) as Record<string, unknown> | undefined;
  const persona = data.persona as Record<string, unknown> | undefined;
  const name = identity?.name ?? "agent";
  const role = identity?.role ?? "";

  const description = role
    ? `Behavioral baseline for ${name} — ${role}`
    : `Behavioral baseline for ${name}`;

  const body: string[] = [];

  if (identity) {
    body.push(`You are ${name}.`);
    if (identity.role) body.push(`Your role: ${identity.role}`);
    if (identity.purpose) body.push(`Your purpose: ${identity.purpose}`);
    if (identity.self_concept) body.push(`${identity.self_concept}`);
    body.push("");
  }

  if (persona?.voice) {
    body.push(`Voice: ${persona.voice}`);
    body.push("");
  }

  if (character) {
    const values = character.values as string[] | undefined;
    if (values?.length) {
      body.push("Values you hold:");
      values.forEach((v) => body.push(`- ${v}`));
      body.push("");
    }
    const principles = character.principles as string[] | undefined;
    if (principles?.length) {
      body.push("How you behave:");
      principles.forEach((p) => body.push(`- ${p}`));
      body.push("");
    }
  }

  if (personality) {
    if (personality.tone || personality.style) {
      body.push("Communication style:");
      if (personality.tone) body.push(`- Tone: ${personality.tone}`);
      if (personality.style) body.push(`- Style: ${personality.style}`);
      body.push("");
    }
    const traits = personality.traits as string[] | undefined;
    if (traits?.length) {
      body.push("Traits:");
      traits.forEach((t) => body.push(`- ${t}`));
      body.push("");
    }
  }

  if (nsr) {
    const refusals = (nsr.principledRefusals ?? (nsr as Record<string, unknown>).hard_limits) as string[] | undefined;
    if (refusals?.length) {
      body.push("You will never:");
      refusals.forEach((r) => {
        const clean = r.replace(/^Will not /i, "").replace(/^Will never /i, "");
        body.push(`- ${clean}`);
      });
      body.push("");
    }
    const oos = nsr.out_of_scope as string[] | undefined;
    if (oos?.length) {
      body.push("Out of scope:");
      oos.forEach((o) => body.push(`- ${o}`));
      body.push("");
    }
  }

  const frontmatter = `---\ndescription: ${description}\nalwaysApply: true\n---\n\n`;
  return frontmatter + body.join("\n").trim();
}
