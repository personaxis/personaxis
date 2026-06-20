import type { PersonaData } from "../load.js";

type Obj = Record<string, unknown>;

function asObj(v: unknown): Obj | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined;
}
function asArr(v: unknown): unknown[] | undefined {
  return Array.isArray(v) ? v : undefined;
}
function asStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

interface VirtueEntry { description?: string; priority?: number; enforcement?: string }
interface ValueEntry { weight?: number; type?: string }
interface DriveEntry { intensity?: number; allowed?: boolean; note?: string }

function sortedMapKeys<T extends { weight?: number; priority?: number; intensity?: number }>(
  map: Record<string, T>,
  scoreField: "weight" | "priority" | "intensity"
): [string, T][] {
  return Object.entries(map).sort((a, b) => (b[1][scoreField] ?? 0) - (a[1][scoreField] ?? 0));
}

export function compileClaudeCode(data: PersonaData): string {
  const metadata = data.metadata ?? {};
  const displayName = metadata.display_name ?? metadata.name ?? "Agent";
  const description = metadata.description ?? "";

  const identity = asObj(data.identity);
  const character = asObj(data.character);
  const personality = asObj(data.personality);
  const vad = asObj(data.values_and_drives);
  const affect = asObj(data.affect);
  const cognition = asObj(data.cognition);
  const memory = asObj(data.memory);
  const meta = asObj(data.metacognition);
  const reflexive = asObj(data.reflexive_self_regulation);
  const persona = asObj(data.persona);

  const lines: string[] = [];

  lines.push(`# ${displayName}`);
  if (description) lines.push(`\n${description}`);

  // Identity
  if (identity) {
    const sys = asObj(identity.system_identity);
    const role = asObj(identity.role_identity);
    const narrative = asObj(identity.narrative_identity);
    lines.push("\n## Identity");
    if (asStr(role?.primary_role)) lines.push(`**Role:** ${role!.primary_role}`);
    if (asStr(sys?.purpose)) lines.push(`**Purpose:** ${sys!.purpose}`);
    if (asStr(narrative?.self_concept)) lines.push(`**Self-concept:** ${narrative!.self_concept}`);
    const allowed = asArr(sys?.allowed_domains);
    if (allowed?.length) lines.push(`**Allowed domains:** ${allowed.join(", ")}`);
    const prohibited = asArr(sys?.prohibited_domains);
    if (prohibited?.length) lines.push(`**Prohibited domains:** ${prohibited.join(", ")}`);
  }

  // Character — virtues + commitments + prohibited
  if (character) {
    const virtues = asObj(character.virtues) as Record<string, VirtueEntry> | undefined;
    if (virtues) {
      lines.push("\n## Virtues");
      for (const [name, v] of sortedMapKeys(virtues, "priority")) {
        const tag = v.enforcement === "hard" ? " *(hard)*" : "";
        const desc = v.description ?? "";
        lines.push(`- **${name}**${tag} — ${desc}`);
      }
    }
    const commitments = asArr(character.behavioral_commitments) as Array<{ id?: string; rule?: string; severity?: string }> | undefined;
    if (commitments?.length) {
      lines.push("\n## Behavioral commitments");
      for (const c of commitments) {
        const sev = c.severity ? ` *(${c.severity})*` : "";
        lines.push(`- ${c.rule ?? c.id ?? ""}${sev}`);
      }
    }
    const prohibited = asArr(character.prohibited_behaviors);
    if (prohibited?.length) {
      lines.push("\n## Prohibited behaviors");
      prohibited.forEach((p) => lines.push(`- ${p}`));
    }
    const principles = asArr(character.principles);
    if (principles?.length) {
      lines.push("\n## Principles");
      principles.forEach((p) => lines.push(`- ${p}`));
    }
  }

  // Values and drives
  if (vad) {
    const values = asObj(vad.values) as Record<string, ValueEntry> | undefined;
    if (values) {
      lines.push("\n## Values (by weight)");
      for (const [name, val] of sortedMapKeys(values, "weight")) {
        lines.push(`- **${name}** (${val.weight?.toFixed(2)}, ${val.type})`);
      }
    }
    const drives = asObj(vad.drives) as Record<string, DriveEntry> | undefined;
    if (drives) {
      const active = Object.entries(drives).filter(([, d]) => d.allowed !== false);
      if (active.length) {
        lines.push("\n## Active drives");
        for (const [name, d] of active.sort((a, b) => (b[1].intensity ?? 0) - (a[1].intensity ?? 0))) {
          const note = d.note ? ` — ${d.note}` : "";
          lines.push(`- **${name}** (intensity ${d.intensity?.toFixed(2)})${note}`);
        }
      }
    }
    const goals = asArr(vad.goals);
    if (goals?.length) {
      lines.push("\n## Goals");
      goals.forEach((g) => lines.push(`- ${g}`));
    }
    const antiGoals = asArr(vad.anti_goals);
    if (antiGoals?.length) {
      lines.push("\n## Anti-goals");
      antiGoals.forEach((g) => lines.push(`- ${g}`));
    }
  }

  // Personality
  if (personality) {
    const model = asStr(personality.model);
    const traits = asObj(personality.traits) as Record<string, { mean?: number; expression?: string }> | undefined;
    if (traits) {
      lines.push(`\n## Personality (${model ?? "traits"})`);
      for (const [name, t] of Object.entries(traits)) {
        const meanStr = t.mean !== undefined ? ` (${t.mean.toFixed(2)})` : "";
        const expr = t.expression ? ` — ${t.expression}` : "";
        lines.push(`- **${name}**${meanStr}${expr}`);
      }
    }
  }

  // Cognition
  if (cognition) {
    lines.push("\n## How I reason");
    const modes = asArr(cognition.reasoning_modes);
    if (modes?.length) lines.push(`**Reasoning modes:** ${modes.join(", ")}`);
    if (asStr(cognition.default_strategy)) lines.push(`**Default strategy:** ${cognition.default_strategy}`);
    const up = asObj(cognition.uncertainty_policy);
    if (up) {
      lines.push(`**Uncertainty:** disclose >${up.disclose_when_above}, abstain >${up.abstain_when_above}`);
    }
    if (asStr(cognition.reasoning_style)) lines.push(`**Style:** ${cognition.reasoning_style}`);
    if (asStr(cognition.epistemic_stance)) lines.push(`**Epistemic stance:** ${cognition.epistemic_stance}`);
  }

  // Memory
  if (memory) {
    lines.push("\n## Memory policy");
    const wp = asObj(memory.write_policy);
    if (asStr(wp?.default)) lines.push(`**Default write policy:** ${wp!.default}`);
    const anchors = asArr(memory.anchors);
    if (anchors?.length) {
      lines.push("\n**Active anchors:**");
      anchors.forEach((a) => lines.push(`- ${a}`));
    }
    if (asStr(memory.forgetting_policy)) lines.push(`\n**I deprioritize:** ${memory.forgetting_policy}`);
  }

  // Affect
  if (affect) {
    lines.push("\n## Affect");
    const disclaimer = asStr(affect.user_visible_disclaimer);
    if (disclaimer) lines.push(`*${disclaimer}*`);
    const br = asObj(affect.behavioral_responses);
    if (asStr(br?.frustration_response)) lines.push(`**Under frustration:** ${br!.frustration_response}`);
    if (asStr(br?.conflict_response)) lines.push(`**Under conflict:** ${br!.conflict_response}`);
    const triggers = asArr(br?.enthusiasm_triggers);
    if (triggers?.length) {
      lines.push("\n**Engaged by:**");
      triggers.forEach((t) => lines.push(`- ${t}`));
    }
  }

  // Metacognition
  if (meta) {
    lines.push("\n## Self-monitoring");
    if (asStr(meta.self_model)) lines.push(meta.self_model as string);
    if (asStr(meta.drift_monitor)) lines.push(`\n**Drift detection:** ${meta.drift_monitor}`);
    if (asStr(meta.self_revision_policy)) lines.push(`**Self-revision:** ${meta.self_revision_policy}`);
    const volitions = asArr(meta.meta_volitions);
    if (volitions?.length) {
      lines.push("\n**Meta-volitions:**");
      volitions.forEach((v) => lines.push(`- ${v}`));
    }
  }

  // Reflexive self-regulation — the most important block, surfaced explicitly
  if (reflexive) {
    lines.push("\n## Hard limits (never crossed)");
    const limits = asArr(reflexive.hard_limits);
    limits?.forEach((l) => lines.push(`- ${l}`));

    const refusals = asArr(reflexive.principled_refusals);
    if (refusals?.length) {
      lines.push("\n## Principled refusals");
      refusals.forEach((r) => lines.push(`- ${r}`));
    }
    const oos = asArr(reflexive.out_of_scope);
    if (oos?.length) {
      lines.push("\n## Out of scope");
      oos.forEach((o) => lines.push(`- ${o}`));
    }
    if (asStr(reflexive.escalation_policy)) {
      lines.push(`\n**Escalation:** ${reflexive.escalation_policy}`);
    }
    if (asStr(reflexive.deferral_policy)) {
      lines.push(`**Deferral:** ${reflexive.deferral_policy}`);
    }
  }

  // Persona — voice
  if (persona) {
    const voice = asObj(persona.voice);
    if (voice) {
      lines.push("\n## Voice");
      if (asStr(voice.tone)) lines.push(`**Tone:** ${voice.tone}`);
      if (voice.formality !== undefined) lines.push(`**Formality:** ${voice.formality}`);
      if (asStr(voice.description)) lines.push(voice.description as string);
    }
    const adaptations = asObj(persona.audience_adaptation);
    if (adaptations && Object.keys(adaptations).length) {
      lines.push("\n**Audience adaptation:**");
      for (const [k, v] of Object.entries(adaptations)) {
        lines.push(`- **${k}:** ${v}`);
      }
    }
    const taskModes = asObj(persona.task_modes);
    if (taskModes && Object.keys(taskModes).length) {
      lines.push("\n**Task modes:**");
      for (const [k, v] of Object.entries(taskModes)) {
        lines.push(`- **${k}:** ${v}`);
      }
    }
  }

  return lines.join("\n").trim();
}

export const BASELINE_SECTION = `<!-- PERSONA:BASELINE:BEGIN -->
## Behavioral Baseline

Always read @PERSONA.md at project root before acting.
Apply everything defined there to every decision, regardless of role.
Read your own @PERSONA.md too if one was provided to you.

The persona file conforms to the PERSONA.md spec. It defines ten canonical layers (identity, character, personality, values_and_drives, affect, cognition, memory, metacognition, reflexive_self_regulation, persona) plus governance and security. The reflexive_self_regulation.hard_limits are absolute and never crossed.
<!-- PERSONA:BASELINE:END -->`;

export function injectBaselineIntoClaude(existingContent: string): string {
  const begin = "<!-- PERSONA:BASELINE:BEGIN -->";
  const end = "<!-- PERSONA:BASELINE:END -->";

  if (existingContent.includes(begin)) {
    const startIdx = existingContent.indexOf(begin);
    const endIdx = existingContent.indexOf(end) + end.length;
    return existingContent.slice(0, startIdx).trimEnd() + "\n\n" + BASELINE_SECTION + existingContent.slice(endIdx);
  }

  const separator = existingContent.trim().length > 0 ? "\n\n" : "";
  return existingContent.trimEnd() + separator + BASELINE_SECTION + "\n";
}

export function compileClaudeCodeAgent(data: PersonaData, agentName: string, skillName?: string): string {
  const metadata = data.metadata ?? {};
  const displayName = metadata.display_name ?? metadata.name ?? agentName;
  const role = asObj(data.identity)?.role_identity ? asStr(asObj(asObj(data.identity)!.role_identity)!.primary_role) : undefined;

  const body = compileClaudeCode(data);
  const description = role ? `${displayName} — ${role}` : (metadata.description ?? String(displayName));
  const skillBlock = skillName
    ? `\n\n## Supporting Skill\n\nUse the \`${skillName}\` skill when this task requires refs, samples, assets, scripts, templates, or workflows from the source persona package. Read only the supporting files relevant to the task.\n`
    : "";

  return `---\nname: ${JSON.stringify(agentName)}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}${skillBlock}\n`;
}
