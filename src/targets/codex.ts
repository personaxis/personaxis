import type { PersonaData } from "../load.js";

const BASELINE_BEGIN = "<!-- PERSONA:BASELINE:BEGIN -->";
const BASELINE_END = "<!-- PERSONA:BASELINE:END -->";
const LEGACY_CODEX_BEGIN = "<!-- PERSONA:CODEX:BEGIN -->";
const LEGACY_CODEX_END = "<!-- PERSONA:CODEX:END -->";

const BASELINE_SECTION = `${BASELINE_BEGIN}
## Behavioral Baseline

Always read @PERSONA.md at project root before acting.
Apply everything defined there to every decision, regardless of role.
Read your own @PERSONA.md too if one was provided to you.

The persona file conforms to the PERSONA.md spec: ten canonical layers (identity, character, personality, values_and_drives, affect, cognition, memory, metacognition, reflexive_self_regulation, persona) plus governance and security. The reflexive_self_regulation.hard_limits are categorical absolutes and are never crossed.
${BASELINE_END}`;

type Obj = Record<string, unknown>;

function asRecord(value: unknown): Obj | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : undefined;
}
function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return values.length ? values : undefined;
}
function pushField(lines: string[], label: string, value: unknown): void {
  const text = asString(value);
  if (text) lines.push(`- ${label}: ${text}`);
}
function pushList(lines: string[], label: string, value: unknown): void {
  const items = asStringArray(value);
  if (!items) return;
  lines.push(`- ${label}:`);
  items.forEach((item) => lines.push(`  - ${item}`));
}
export function tomlString(value: string): string {
  return JSON.stringify(value);
}
function isValidNickname(value: string): boolean {
  return /^[A-Za-z0-9 _-]+$/.test(value) && value.trim().length > 0;
}
function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function buildPersonaInstructions(data: PersonaData, heading: string, skillName?: string): string {
  const metadata = data.metadata ?? {};
  const extensions = data.extensions ?? {};
  const identity = asRecord(data.identity);
  const character = asRecord(data.character);
  const personality = asRecord(data.personality);
  const vad = asRecord(data.values_and_drives);
  const affect = asRecord(data.affect);
  const cognition = asRecord(data.cognition);
  const memory = asRecord(data.memory);
  const meta = asRecord(data.metacognition);
  const reflexive = asRecord(data.reflexive_self_regulation);
  const persona = asRecord(data.persona);
  const governance = asRecord(data.governance);

  const lines: string[] = [
    heading,
    "",
    "PERSONA.md is the source of truth for behavioral identity. If a root PERSONA.md is present, read it before acting and apply it together with these compiled instructions.",
    "",
  ];

  // Metadata
  lines.push("## Metadata");
  pushField(lines, "Display name", metadata.display_name);
  pushField(lines, "Description", metadata.description);
  pushField(lines, "Version", metadata.version);
  lines.push("");

  if (identity) {
    const sys = asRecord(identity.system_identity);
    const role = asRecord(identity.role_identity);
    const narrative = asRecord(identity.narrative_identity);
    lines.push("## Identity");
    pushField(lines, "Canonical id", identity.canonical_id);
    pushField(lines, "Primary role", role?.primary_role);
    pushField(lines, "Purpose", sys?.purpose);
    pushList(lines, "Allowed domains", sys?.allowed_domains);
    pushList(lines, "Prohibited domains", sys?.prohibited_domains);
    pushField(lines, "Self-concept", narrative?.self_concept);
    pushList(lines, "Continuity principles", narrative?.continuity_principles);
    lines.push("");
  }

  if (character) {
    lines.push("## Character");
    const virtues = asRecord(character.virtues);
    if (virtues) {
      lines.push("- Virtues:");
      for (const [name, vRaw] of Object.entries(virtues)) {
        const v = asRecord(vRaw);
        const enf = asString(v?.enforcement) ?? "";
        const desc = asString(v?.description) ?? "";
        lines.push(`  - ${name} (${enf}): ${desc}`);
      }
    }
    const commitments = data.character ? (asRecord(data.character)!.behavioral_commitments as Array<{ id?: string; rule?: string; severity?: string }> | undefined) : undefined;
    if (commitments?.length) {
      lines.push("- Behavioral commitments:");
      for (const c of commitments) {
        lines.push(`  - [${c.severity ?? "?"}] ${c.rule ?? c.id ?? ""}`);
      }
    }
    pushList(lines, "Prohibited behaviors", character.prohibited_behaviors);
    pushList(lines, "Principles", character.principles);
    lines.push("");
  }

  if (personality) {
    lines.push("## Personality");
    pushField(lines, "Model", personality.model);
    const traits = asRecord(personality.traits);
    if (traits) {
      lines.push("- Traits:");
      for (const [k, tRaw] of Object.entries(traits)) {
        const t = asRecord(tRaw);
        const mean = typeof t?.mean === "number" ? ` (mean ${t!.mean.toFixed(2)})` : "";
        const expr = asString(t?.expression) ?? "";
        lines.push(`  - ${k}${mean}${expr ? `: ${expr}` : ""}`);
      }
    }
    lines.push("");
  }

  if (vad) {
    lines.push("## Values and Drives");
    const values = asRecord(vad.values);
    if (values) {
      lines.push("- Values (by weight):");
      const sorted = Object.entries(values)
        .map(([k, v]) => [k, asRecord(v)] as const)
        .sort((a, b) => (Number(b[1]?.weight ?? 0) - Number(a[1]?.weight ?? 0)));
      for (const [k, v] of sorted) {
        lines.push(`  - ${k} (${Number(v?.weight ?? 0).toFixed(2)}, ${asString(v?.type) ?? "?"})`);
      }
    }
    const drives = asRecord(vad.drives);
    if (drives) {
      lines.push("- Drives:");
      for (const [k, dRaw] of Object.entries(drives)) {
        const d = asRecord(dRaw);
        const inten = typeof d?.intensity === "number" ? d!.intensity.toFixed(2) : "?";
        const allowed = d?.allowed === false ? " (disallowed)" : "";
        lines.push(`  - ${k} (intensity ${inten})${allowed}`);
      }
    }
    pushList(lines, "Goals", vad.goals);
    pushList(lines, "Anti-goals", vad.anti_goals);
    pushList(lines, "Motivations", vad.motivations);
    lines.push("");
  }

  if (affect) {
    lines.push("## Affect");
    pushField(lines, "Disclaimer", affect.user_visible_disclaimer);
    const br = asRecord(affect.behavioral_responses);
    if (br) {
      pushField(lines, "Under frustration", br.frustration_response);
      pushField(lines, "Under conflict", br.conflict_response);
      pushList(lines, "Enthusiasm triggers", br.enthusiasm_triggers);
    }
    lines.push("");
  }

  if (cognition) {
    lines.push("## Cognition");
    pushList(lines, "Reasoning modes", cognition.reasoning_modes);
    pushField(lines, "Default strategy", cognition.default_strategy);
    const up = asRecord(cognition.uncertainty_policy);
    if (up) {
      lines.push(`- Uncertainty: disclose>${up.disclose_when_above}, abstain>${up.abstain_when_above}`);
    }
    pushField(lines, "Reasoning style", cognition.reasoning_style);
    pushField(lines, "Epistemic stance", cognition.epistemic_stance);
    lines.push("");
  }

  if (memory) {
    lines.push("## Memory");
    const wp = asRecord(memory.write_policy);
    pushField(lines, "Default write policy", wp?.default);
    pushList(lines, "Anchors", memory.anchors);
    pushField(lines, "Forgetting policy", memory.forgetting_policy);
    pushField(lines, "Working self", memory.working_self);
    lines.push("");
  }

  if (meta) {
    lines.push("## Metacognition");
    pushField(lines, "Self-model", meta.self_model);
    pushField(lines, "Drift monitor", meta.drift_monitor);
    pushField(lines, "Self-revision policy", meta.self_revision_policy);
    pushList(lines, "Meta-volitions", meta.meta_volitions);
    pushField(lines, "Uncertainty calibration", meta.uncertainty_calibration);
    lines.push("");
  }

  if (reflexive) {
    lines.push("## Reflexive Self-Regulation");
    pushList(lines, "Hard limits (categorical — never crossed)", reflexive.hard_limits);
    pushList(lines, "Principled refusals", reflexive.principled_refusals);
    pushList(lines, "Out of scope", reflexive.out_of_scope);
    pushField(lines, "Escalation policy", reflexive.escalation_policy);
    pushField(lines, "Deferral policy", reflexive.deferral_policy);
    lines.push("");
  }

  if (persona) {
    const voice = asRecord(persona.voice);
    lines.push("## Persona");
    if (voice) {
      pushField(lines, "Tone", voice.tone);
      pushField(lines, "Formality", voice.formality);
      pushField(lines, "Verbosity", voice.verbosity);
      pushField(lines, "Humor", voice.humor);
      pushField(lines, "Description", voice.description);
    }
    pushField(lines, "Presentation", persona.presentation);
    const adaptations = asRecord(persona.audience_adaptation);
    if (adaptations && Object.keys(adaptations).length) {
      lines.push("- Audience adaptation:");
      for (const [k, v] of Object.entries(adaptations)) {
        if (typeof v === "string") lines.push(`  - ${k}: ${v}`);
      }
    }
    const taskModes = asRecord(persona.task_modes);
    if (taskModes && Object.keys(taskModes).length) {
      lines.push("- Task modes:");
      for (const [k, v] of Object.entries(taskModes)) {
        if (typeof v === "string") lines.push(`  - ${k}: ${v}`);
      }
    }
    lines.push("");
  }

  if (governance) {
    lines.push("## Governance");
    pushField(lines, "Autonomy envelope", governance.autonomy_envelope);
    pushField(lines, "Approval policy", governance.approval_policy);
    lines.push("");
  }

  const skills = asStringArray(extensions.skills);
  if (skills) {
    lines.push("## Declared Skills");
    lines.push("The PERSONA.md file declares these skills. Codex only discovers them when matching SKILL.md packages exist in `.agents/skills` or `$HOME/.agents/skills`.");
    skills.forEach((skill) => lines.push(`- ${skill}`));
    lines.push("");
  }

  if (skillName) {
    lines.push("## Supporting Skill");
    lines.push(`Use the \`${skillName}\` skill when this task requires refs, samples, assets, scripts, templates, or workflows from the source persona package.`);
    lines.push("");
  }

  lines.push("## Codex Integration Boundaries");
  lines.push("- This compiler renders PERSONA.md as natural-language instructions.");
  lines.push("- Do not map principled refusals or hard limits to `.codex/rules`; those rules control command approval, not behavioral identity.");

  return lines.join("\n").trim();
}

export function compileCodexBaseline(): string {
  return BASELINE_SECTION;
}

export function injectBaselineIntoAgents(existingContent: string): string {
  const section = compileCodexBaseline();
  const managedRanges = [
    { begin: BASELINE_BEGIN, end: BASELINE_END },
    { begin: LEGACY_CODEX_BEGIN, end: LEGACY_CODEX_END },
  ];

  for (const range of managedRanges) {
    if (!existingContent.includes(range.begin)) continue;
    const startIdx = existingContent.indexOf(range.begin);
    const endIdx = existingContent.indexOf(range.end);
    if (endIdx !== -1) {
      return (
        existingContent.slice(0, startIdx).trimEnd() +
        "\n\n" +
        section +
        existingContent.slice(endIdx + range.end.length)
      );
    }
  }

  const separator = existingContent.trim().length > 0 ? "\n\n" : "";
  return existingContent.trimEnd() + separator + section + "\n";
}

export function compileCodexAgent(data: PersonaData, slug: string, skillName?: string): string {
  const metadata = data.metadata ?? {};
  const identity = asRecord(data.identity);
  const role = asRecord(identity?.role_identity);
  const sys = asRecord(identity?.system_identity);

  const displayName = asString(metadata.display_name) ?? asString(metadata.name) ?? slug;
  const roleName = asString(role?.primary_role);
  const purpose = asString(sys?.purpose) ?? asString(metadata.description);
  const descriptionBase = [displayName, roleName].filter(Boolean).join(" - ") || slug;
  const instructions = buildPersonaInstructions(
    data,
    `# ${displayName} Codex Custom Agent`,
    skillName,
  );

  const nicknameCandidates = unique([displayName].filter((v): v is string => !!v && v !== slug && isValidNickname(v)));

  const lines = [
    `name = ${tomlString(slug)}`,
    `description = ${tomlString(purpose ? `${descriptionBase}. ${purpose}` : descriptionBase)}`,
    `developer_instructions = ${tomlString(instructions)}`,
  ];
  if (nicknameCandidates.length) {
    lines.push(`nickname_candidates = [${nicknameCandidates.map(tomlString).join(", ")}]`);
  }
  return lines.join("\n") + "\n";
}
