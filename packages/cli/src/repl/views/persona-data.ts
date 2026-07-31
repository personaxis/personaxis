/**
 * Persona miniapp data (V5.P3.3): Identity / Anatomy / Resources / Sub-personas /
 * Evolution / Values as plain chalk lines over the tabbed host. Anatomy walks the
 * TEN canonical layers with a one-line summary each, so the user finally SEES the
 * anatomy their persona is made of.
 */

import chalk from "chalk";
import { dirname } from "node:path";
import {
  readState,
  sigilParams,
  liveIntensity,
  readArbitrationValues,
  rankValues,
  extractEnvelopes,
  driftReport,
  readMaxStepDelta,
  readDriftThresholds,
  proposals,
} from "@personaxis/core";
import { auraLines, AURA_WIDTH } from "@personaxis/tui/visual";
import { slugAddressFromPath, isSubagentPath } from "../../load.js";
import { buildResourceManifest } from "../../resource-manifest.js";
import { discoverTree } from "../roster.js";
import { goalPathFor, readGoalAt, writeGoalAt } from "../config.js";
import type { TabLine, TabAction } from "./tabbed.js";
import { qualitativeReport } from "./drift-data.js";
import type { Ctx } from "../types.js";
import { POSTURES } from "../config.js";

/** Global drift D right now, so the aura can flare when the persona is off its box. */
function driftFor(ctx: Ctx): number {
  try {
    const st = readState(ctx.handle.statePath);
    const env = extractEnvelopes(ctx.handle.frontmatter);
    const fm = ctx.handle.frontmatter as Record<string, unknown>;
    return driftReport({
      values: st.values,
      envelopes: env.envelopes,
      maxStepDelta: readMaxStepDelta(fm),
      thresholds: readDriftThresholds(fm),
      protectedFields: env.protectedFields,
    }).global;
  } catch {
    return 0;
  }
}

/**
 * State values, or an empty set when the persona has no state.json yet.
 *
 * A freshly created sub-persona has a spec but no state until something mutates it, and
 * `readState` throws on the missing file. Before V7.C nothing rendered another persona, so
 * that throw was unreachable; the moment the Persona view could be scoped to a sub, it
 * took the WHOLE view down to a blank screen. A view must degrade to "not initialized
 * yet", never to nothing.
 */
function readStateValues(statePath: string): Record<string, number> {
  try {
    return readState(statePath).values;
  } catch {
    return {};
  }
}

type FM = Record<string, unknown>;
const get = (fm: FM, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as FM)[k] : undefined), fm);
const count = (v: unknown): number => (v && typeof v === "object" ? Object.keys(v as object).length : Array.isArray(v) ? v.length : 0);
const row = (label: string, value: string): string => `  ${chalk.cyan(label.padEnd(18))} ${value}`;

/**
 * Milliseconds per aura frame. The host is told to redraw at exactly this rate, so one
 * redraw equals one frame: any slower and the figure stutters, any faster and the host
 * repaints frames that are identical. 250 ms means the fastest of the five motions (a
 * 2-frame rhythm) completes in half a second, which is what "se nota que se mueve" needs.
 */
export const AURA_FRAME_MS = 250;

export function identityLines(ctx: Ctx): string[] {
  const fm = ctx.handle.frontmatter as FM;
  const p = ctx.handle.personaPath;
  const address = slugAddressFromPath(p);
  const values = readStateValues(ctx.handle.statePath);
  // V7.D: the aura is ALIVE here. It used to be asked for frame 0 on every render, so it
  // never moved no matter how often the view refreshed (it never appeared to be animated at all). The frame comes from the clock, so each tick of the miniapp
  // advances it; PERSONAXIS_NO_ANIM pins frame 0 for deterministic tests.
  const frame = process.env.PERSONAXIS_NO_ANIM === "1" ? 0 : Math.floor(Date.now() / AURA_FRAME_MS);
  const figure = auraLines(sigilParams(ctx.handle.frontmatter), frame, {
    intensity: liveIntensity(values, frame),
    drift: driftFor(ctx),
  }).split("\n");

  // Figure on the LEFT, its data on the right. The figure keeps
  // a fixed width, so the data column starts at the same place on every row and neither
  // side wraps into the other.
  // Long prose (a purpose can be a paragraph) is trimmed so the two columns stay two
  // columns; the full text lives in the spec and in Anatomy.
  const brief = (s: string, max = 62): string => (s.length > max ? s.slice(0, max - 1).replace(/\s+\S*$/, "") + "…" : s);
  const facts: string[] = [
    row("name", String(get(fm, "identity.display_name") ?? ctx.name)),
    row("here", isSubagentPath(p) && address ? `sub-persona @${address}` : "main persona of this project"),
    row("role", String(get(fm, "identity.role_identity.primary_role") ?? "-")),
    row("purpose", brief(String(get(fm, "identity.system_identity.purpose") ?? "-"))),
    row("serves", brief(String(get(fm, "identity.role_identity.relationship_to_user") ?? "-"))),
    row("spec", `spec_version ${String(get(fm, "spec_version") ?? "?")} · ${String(get(fm, "apiVersion") ?? "")}`),
    row("session", `improve ${ctx.mode} · sandbox ${POSTURES[ctx.postureIndex]}`),
    row("aura", chalk.dim(`seed ${sigilParams(ctx.handle.frontmatter).seed.toString(16).slice(0, 8)} · unique to this persona`)),
  ];
  // A persona with no state yet is a normal thing (nothing has moved it), but say so, and
  // say how to change it: no warning without its remedy.
  if (Object.keys(values).length === 0) {
    facts.push(
      row("state", chalk.yellow("not initialized yet") + chalk.dim("  ·  personaxis state init")),
    );
  }
  return sideBySide(figure, facts);
}

/**
 * Compose two columns: the living figure on the left, its data on the right, vertically
 * centered against each other and padded to the figure's fixed width so nothing drifts
 * as the character breathes.
 */
function sideBySide(figure: string[], facts: string[]): string[] {
  const gap = "   ";
  const pad = " ".repeat(AURA_WIDTH);
  const height = Math.max(figure.length, facts.length);
  // Both columns start at the top: a small figure floating in the middle of a fact list
  // reads as misalignment, not as composition.
  const figTop = 0;
  const factTop = 0;
  const out: string[] = [];
  for (let i = 0; i < height; i++) {
    const fig = i >= figTop && i - figTop < figure.length ? figure[i - figTop] : pad;
    const fact = i >= factTop && i - factTop < facts.length ? facts[i - factTop] : "";
    out.push(`  ${fig}${gap}${fact}`.replace(/\s+$/, ""));
  }
  return out;
}

/** The TEN canonical layers, one line each: what is declared, at a glance. */
export function anatomyLines(ctx: Ctx): string[] {
  const fm = ctx.handle.frontmatter as FM;
  const layers: Array<[string, string]> = [
    ["1 identity", `${String(get(fm, "identity.display_name") ?? "?")} · role ${String(get(fm, "identity.role_identity.primary_role") ?? "-")}`],
    ["2 character", `${count(get(fm, "character.virtues"))} virtue(s) (honesty ${String(get(fm, "character.virtues.honesty.enforcement") ?? "?")}) · ${count(get(fm, "character.prohibited_behaviors"))} prohibited`],
    ["3 personality", `${count(get(fm, "personality.traits"))} trait(s) · model ${String(get(fm, "personality.model") ?? "-")}`],
    ["4 values_and_drives", `${count(get(fm, "values_and_drives.values"))} value(s) · safety ${String(get(fm, "values_and_drives.values.safety.weight") ?? "?")}`],
    ["5 affect", `${String(get(fm, "affect.representation") ?? "-")} · mood half_life ${String(get(fm, "affect.baseline.mood.tone.half_life") ?? "-")}`],
    ["6 cognition", `${String(get(fm, "cognition.default_strategy") ?? "-")} · disclose>${String(get(fm, "cognition.uncertainty_policy.disclose_when_above") ?? "?")} abstain>${String(get(fm, "cognition.uncertainty_policy.abstain_when_above") ?? "?")}`],
    ["7 memory", `types on: ${Object.entries((get(fm, "memory.types") as FM) ?? {}).filter(([, v]) => v).map(([k]) => k).join(", ") || "-"}`],
    ["8 metacognition", get(fm, "metacognition") ? `${count(get(fm, "metacognition"))} field(s) declared` : chalk.dim("(template defaults)")],
    ["9 self_regulation", `${count(get(fm, "self_regulation.hard_limits"))} hard limit(s) · ${count(get(fm, "self_regulation.prohibited_behaviors"))} prohibited`],
    ["10 persona", `voice ${String(get(fm, "persona.voice.tone") ?? "-")} · ${count(get(fm, "persona.voice_exemplars"))} exemplar(s)`],
  ];
  return [
    chalk.dim("  the ten canonical layers of this persona's anatomy (spec: personaxis.md)"),
    "",
    ...layers.map(([name, summary]) => `  ${chalk.cyan(name.padEnd(22))} ${summary}`),
  ];
}

export function resourcesLines(ctx: Ctx): string[] {
  const dir = dirname(ctx.handle.personaPath);
  const manifest = buildResourceManifest(dir);
  return [
    chalk.dim(`  everything under ${dir} belongs to this persona`),
    "",
    ...(manifest.trim() ? manifest.split("\n").map((l) => `  ${l}`) : [chalk.dim("  (no supporting resources yet)")]),
  ];
}

export function subsLines(ctx: Ctx): string[] {
  const subs = discoverTree(ctx.handle.personaPath);
  if (!subs.length) return [chalk.dim("  no sub-personas. Create one: /create (or /init <name> for a quick template)")];
  return [
    chalk.dim("  address one with @<address>; they read each other's files but never write them"),
    "",
    ...subs.map((s) => `  ${"  ".repeat(s.depth - 1)}${chalk.cyan(`@${s.address}`)}`),
  ];
}

/**
 * Evolution is where the verbs that used to be their own commands now LIVE (V8.A).
 *
 * `/goal`, `/loop`, `/improve` and `/review` were absorbed here. Absorbed has to mean the
 * capability moved, not that the command is hidden but still typed: a hidden command that
 * still works is exactly the clutter this consolidation set out to remove. So these are
 * actionable rows, and each one still has a non-interactive door for agents and scripts.
 */
export function evolutionLines(ctx: Ctx): TabLine[] {
  const r = qualitativeReport(ctx.handle.personaPath);
  const goalPath = goalPathFor(ctx.handle.personaPath);
  const currentGoal = readGoalAt(goalPath);

  const lines: TabLine[] = [
    chalk.dim("  a standing GOAL steers the persona; the LOOP is how it matures against that goal"),
    chalk.dim("  without a conversation: observe → appraise → evolve → recompile → remember."),
    "",
    {
      label: "goal",
      value: currentGoal ? chalk.cyan(currentGoal) : chalk.dim("none"),
      hint: "Enter sets the standing objective the persona carries into every turn",
      onEnter: async (): Promise<TabAction> => {
        if (!ctx.ask) return { kind: "toast", text: "outside a terminal, use: personaxis goal <text>" };
        const text = (await ctx.ask("  goal (empty clears it): ")).trim();
        writeGoalAt(goalPath, text);
        return { kind: "toast", text: text ? `goal set: ${text}` : "goal cleared" };
      },
    },
    {
      // Named `loop`, not "run ticks": "agent loop" and "goal" are the words this
      // capability is known by, and renaming a recognised feature into house jargon
      // costs recognition for nothing.
      label: "loop",
      value: chalk.dim("observe → appraise → evolve → recompile → remember"),
      hint: "Enter runs N governed Living-Loop ticks, each evaluated against the standing goal",
      onEnter: async (): Promise<TabAction> => {
        if (!ctx.ask) return { kind: "toast", text: "outside a terminal, use: personaxis observe" };
        const n = Number((await ctx.ask("  how many ticks? ")).trim()) || 0;
        if (n <= 0) return { kind: "toast", text: "nothing to run" };
        let applied = 0;
        for (let i = 0; i < Math.min(n, 20); i++) {
          const rep = await ctx.loop
            .tick({ observation: "scheduled tick", source: "internal", actor: "actor-llm", sessionId: ctx.sessionId })
            .catch(() => undefined);
          applied += rep?.mutationsApplied ?? 0;
        }
        return { kind: "toast", text: `${Math.min(n, 20)} tick(s) · ${applied} mutation(s) applied` };
      },
    },
    row("improve mode", ctx.mode + chalk.dim("  (change it in /status → Config, per persona)")),
    row("applied edits", String(r.totalApplied)),
    {
      label: "pending edits",
      value: r.totalPending ? chalk.yellow(String(r.totalPending)) : "0",
      hint: r.totalPending ? "Enter lists the proposed edits so you can approve or reject them" : "nothing waiting",
      onEnter: (): TabAction => ({
        kind: "drill",
        title: "proposed self-edits",
        lines: () => {
          const pending = proposals(ctx.handle.personaPath).filter((x) => x.status === "pending");
          if (!pending.length) return [chalk.dim("  nothing pending. Edits arrive here when improve is 'suggesting'.")];
          return [
            chalk.dim("  each one waits for a person; approving mints a new persona version"),
            chalk.dim("  decide them with:  personaxis review approve <id> | reject <id> | approve all"),
            "",
            ...pending.map(
              (x) => `  ${chalk.yellow(x.id)}  ${chalk.cyan(x.targetPath)} → ${String(x.toValue)}  ${chalk.dim(x.rationale)}`,
            ),
          ];
        },
      }),
    },
  ];
  if (r.layers.length) {
    lines.push("", chalk.bold("  Changes by layer"));
    for (const l of r.layers) lines.push(`  ${chalk.cyan(l.layer.padEnd(20))} ${l.applied} applied · ${l.pending} pending${l.lastTs ? chalk.dim(` · last ${l.lastTs.slice(0, 10)}`) : ""}`);
  }
  if (r.specChangedSinceCompile) lines.push("", chalk.yellow("  ⚠ spec text changed since the last compile (/compile refreshes)"));
  return lines;
}

export function valuesLines(ctx: Ctx): string[] {
  const values = readArbitrationValues(ctx.handle.frontmatter as FM);
  if (!values.length) return [chalk.dim("  no weighted values declared")];
  const ranked = rankValues(values);
  return [
    chalk.dim("  when two declared values collide, this order decides (governance ≻ weight ≻ name)"),
    chalk.dim("  runtime limits are ENFORCED via protected fields + hard virtues; this explains decisions"),
    "",
    ...ranked.map((v, i) => `  ${String(i + 1).padStart(2)}. ${chalk.cyan(v.name)} ${chalk.dim(String(v.weight))}${v.type === "governance" ? chalk.magenta(" governance") : ""}`),
  ];
}

export const PERSONA_TABS = ["Identity", "Anatomy", "Resources", "Sub-personas", "Evolution", "Values"] as const;

export function personaLines(ctx: Ctx, tab: number): TabLine[] {
  switch (tab) {
    case 1:
      return anatomyLines(ctx);
    case 2:
      return resourcesLines(ctx);
    case 3:
      return subsLines(ctx);
    case 4:
      return evolutionLines(ctx);
    case 5:
      return valuesLines(ctx);
    default:
      return identityLines(ctx);
  }
}
