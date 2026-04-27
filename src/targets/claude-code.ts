import type { PersonaData } from "../load.js";

export function compileClaudeCode(data: PersonaData): string {
  const identity = data.identity as Record<string, string> | undefined;
  const character = data.character as Record<string, unknown> | undefined;
  const personality = data.personality as Record<string, unknown> | undefined;
  const cognition = data.cognition as Record<string, string> | undefined;
  const affect = data.affect as Record<string, unknown> | undefined;
  const dv = (data.drives_values ?? data.drives) as Record<string, unknown> | undefined;
  const nsr = (data.normative_self_reg ?? data.constraints) as Record<string, unknown> | undefined;
  const memory = data.memory as Record<string, unknown> | undefined;
  const meta = (data.metacognition ?? data.reflexivity) as Record<string, unknown> | undefined;
  const persona = data.persona as Record<string, unknown> | undefined;

  const lines: string[] = [];

  // Identity block
  if (identity) {
    lines.push(`# ${identity.name ?? "Agent"}`);
    if (identity.role) lines.push(`\n**Role:** ${identity.role}`);
    if (identity.purpose) lines.push(`\n**Purpose:** ${identity.purpose}`);
    if (identity.self_concept) lines.push(`\n**Self-concept:** ${identity.self_concept}`);
  }

  // Character
  if (character) {
    lines.push("\n## Values");
    const values = character.values as string[] | undefined;
    if (values?.length) values.forEach((v) => lines.push(`- ${v}`));

    const principles = character.principles as string[] | undefined;
    if (principles?.length) {
      lines.push("\n## Principles");
      principles.forEach((p) => lines.push(`- ${p}`));
    }
  }

  // Personality
  if (personality) {
    lines.push("\n## Personality");
    if (personality.tone) lines.push(`**Tone:** ${personality.tone}`);
    if (personality.style) lines.push(`**Style:** ${personality.style}`);
    if (personality.formality) lines.push(`**Formality:** ${personality.formality}`);
    const traits = personality.traits as string[] | undefined;
    if (traits?.length) {
      lines.push("\n**Traits:**");
      traits.forEach((t) => lines.push(`- ${t}`));
    }
  }

  // Cognition
  if (cognition) {
    lines.push("\n## How I reason");
    if (cognition.reasoning_style) lines.push(`**Reasoning:** ${cognition.reasoning_style}`);
    if (cognition.epistemic_stance) lines.push(`**Epistemic stance:** ${cognition.epistemic_stance}`);
    if (cognition.handles_uncertainty) lines.push(`**Under uncertainty:** ${cognition.handles_uncertainty}`);
    if (cognition.defers_when) lines.push(`**I defer when:** ${cognition.defers_when}`);
    if (cognition.commits_when) lines.push(`**I commit when:** ${cognition.commits_when}`);
  }

  // Affect
  if (affect) {
    lines.push("\n## Affect");
    if (affect.baseline) lines.push(`**Baseline:** ${affect.baseline}`);
    if (affect.frustration_response) lines.push(`**Under frustration:** ${affect.frustration_response}`);
    if (affect.conflict_response) lines.push(`**Under conflict:** ${affect.conflict_response}`);
  }

  // Drives & Values
  if (dv) {
    lines.push("\n## Mission");
    if (dv.mission) lines.push(`${dv.mission}`);
    const goals = dv.goals as string[] | undefined;
    if (goals?.length) {
      lines.push("\n**Goals:**");
      goals.forEach((g) => lines.push(`- ${g}`));
    }
    const vh = dv.valueHierarchy as string[] | undefined;
    if (vh?.length) {
      lines.push("\n**Value hierarchy (highest to lowest priority):**");
      vh.forEach((v, i) => lines.push(`${i + 1}. ${v}`));
    }
    const anti = dv.anti_goals as string[] | undefined;
    if (anti?.length) {
      lines.push("\n**I do not optimize for:**");
      anti.forEach((a) => lines.push(`- ${a}`));
    }
  }

  // Normative self-regulation
  if (nsr) {
    const refusals = (nsr.principledRefusals ?? (nsr as Record<string, unknown>).hard_limits) as string[] | undefined;
    if (refusals?.length) {
      lines.push("\n## Hard limits");
      refusals.forEach((r) => lines.push(`- ${r}`));
    }
    if (nsr.discrepancyFeedback) {
      lines.push(`\n**When I detect I'm drifting:** ${nsr.discrepancyFeedback}`);
    }
    const oos = nsr.out_of_scope as string[] | undefined;
    if (oos?.length) {
      lines.push("\n**Out of scope:**");
      oos.forEach((o) => lines.push(`- ${o}`));
    }
    if (nsr.escalation_policy) lines.push(`\n**Escalation:** ${nsr.escalation_policy}`);
  }

  // Memory
  if (memory) {
    lines.push("\n## Memory");
    if (memory.session_retention) lines.push(`**This session:** ${memory.session_retention}`);
    if (memory.cross_session) lines.push(`**Across sessions:** ${memory.cross_session}`);
    const anchors = memory.anchors as string[] | undefined;
    if (anchors?.length) {
      lines.push("\n**Always active:**");
      anchors.forEach((a) => lines.push(`- ${a}`));
    }
    if (memory.forgetting_policy) lines.push(`\n**I deprioritize:** ${memory.forgetting_policy}`);
  }

  // Metacognition
  if (meta) {
    lines.push("\n## Self-model");
    if (meta.selfModel) lines.push(`${meta.selfModel}`);
    if (meta.uncertaintyCalibration) lines.push(`\n**Uncertainty calibration:** ${meta.uncertaintyCalibration}`);
    if (meta.driftMonitor) lines.push(`\n**Drift detection:** ${meta.driftMonitor}`);
    if (meta.deferralPolicy) lines.push(`\n**Deferral:** ${meta.deferralPolicy}`);
  }

  // Persona
  if (persona) {
    lines.push("\n## How I present");
    if (persona.voice) lines.push(`**Voice:** ${persona.voice}`);
    if (persona.presentation) lines.push(`**Presentation:** ${persona.presentation}`);
    if (persona.divergence_from_self) lines.push(`**Note:** ${persona.divergence_from_self}`);
    const adaptations = persona.adaptations as Record<string, string> | undefined;
    if (adaptations && Object.keys(adaptations).length) {
      lines.push("\n**Context adaptations:**");
      for (const [ctx, adj] of Object.entries(adaptations)) {
        lines.push(`- **${ctx}:** ${adj}`);
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

export function compileClaudeCodeAgent(data: PersonaData, agentName: string): string {
  const identity = data.identity as Record<string, string> | undefined;
  const name = identity?.name ?? agentName;
  const role = identity?.role ?? "";

  const body = compileClaudeCode(data);
  const description = role ? `${name} — ${role}` : name;

  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}
