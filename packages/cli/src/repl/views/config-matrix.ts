/**
 * THE CONFIGURATION MATRIX.
 *
 * A setting like the model, the improvement mode or the sandbox posture can be configured
 * globally, per project, for the main persona, or differently for each sub-persona. A
 * config screen that lists only the CURRENT session's values leaves the reader guessing
 * which of those scopes they are looking at.
 *
 * So Config is a grid: one row per setting, one column per persona, every cell showing the
 * effective value and whether this persona owns it or inherited it. Nothing implicit.
 *
 * Why a grid AND a drill-down, rather than only the grid: a project can hold twenty
 * sub-personas, and twenty columns fit in no terminal. The grid shows as many columns as
 * the width allows and says how many it hid; Enter on any row opens that setting for EVERY
 * persona, one per line, with its origin spelled out. The grid is the overview, the drill
 * is the truth, and neither of them lies about what it is showing.
 */

import chalk from "chalk";
import {
  personaScopes,
  settingFor,
  MATRIX_SETTINGS,
  type MatrixSetting,
  type PersonaScope,
  type EffectiveSetting,
} from "../scope.js";
import { visibleWidth } from "../render.js";
import type { Ctx } from "../types.js";
import type { TabLine, TabAction } from "./tabbed.js";

/** What each row of the matrix means, in one line, in plain language. */
const MEANING: Record<MatrixSetting, string> = {
  model: "which model answers for this persona",
  improve: "how much this persona may evolve on its own",
  sandbox: "what the session is allowed to run (one posture per terminal)",
  memory: "which kinds of memory this persona keeps",
  hooks: "which host agents this persona is compiled into",
};

/** Where a value came from, said the way a person would say it. */
const ORIGIN_TEXT: Record<EffectiveSetting["origin"], string> = {
  default: "nothing configured, using the built-in default",
  global: "the global config (~/.personaxis/config.json), shared by all your projects",
  project: "this project's config (.personaxis/config.json)",
  assigned: "assigned to this persona by name in a config file",
  spec: "this persona's own personaxis.md",
  policy: "the sibling policy.yaml, which caps what the spec may ask for",
  env: "an environment variable (PERSONAXIS_*), which overrides every file",
  session: "this session (this terminal)",
};

/**
 * Column where a row's VALUE starts, in both renderers: the Ink host paints
 * `cursor(2) + label.padEnd(14) + " "`, and `lineText` uses the same shape for pipes.
 * Continuation lines align to it so a value and its explanation read as one unit.
 */
const VALUE_COL = 17;

const pad = (s: string, w: number): string => {
  const v = visibleWidth(s);
  return v >= w ? s : s + " ".repeat(w - v);
};

/** Truncate to a visible width, keeping styling intact by cutting the plain text first. */
const clip = (s: string, w: number): string => (s.length <= w ? s : s.slice(0, Math.max(1, w - 1)) + "…");

/**
 * The grid. Columns are personas; the first is always the main one, so the reading order
 * matches the hierarchy. Cells mark inherited values dim and owned values bright, which is
 * the whole point: at a glance you see which personas differ from what they inherited.
 */
export function configMatrixLines(ctx: Ctx, width = process.stdout.columns ?? 80, edit?: CellEditor): TabLine[] {
  const scopes = personaScopes(ctx);
  const colW = 18;
  // Persona columns start where the host puts a row's value, so the header sits exactly
  // over the cells it names. Fit as many as the terminal actually has room for rather
  // than wrapping into an unreadable mess.
  const fits = Math.max(1, Math.floor((width - VALUE_COL - 2) / colW));
  const shown = scopes.slice(0, fits);
  const hidden = scopes.length - shown.length;

  const head =
    " ".repeat(VALUE_COL) + shown.map((s) => chalk.bold(pad(clip(s.label, colW - 1), colW))).join("");

  const out: TabLine[] = [
    chalk.dim("  every setting, for every persona: bright = this persona set it, dim = inherited"),
    "",
    head,
  ];

  for (const setting of MATRIX_SETTINGS) {
    const cells = shown
      .map((scope) => {
        const eff = settingFor(ctx, scope, setting);
        const text = clip(eff.value, colW - 1);
        return pad(eff.own ? chalk.white(text) : chalk.dim(text), colW);
      })
      .join("");
    out.push({
      label: setting,
      value: cells,
      hint: `Enter shows ${setting} for every persona, with where each value comes from`,
      onEnter: (): TabAction => ({
        kind: "drill",
        title: setting,
        lines: () => settingDetailLines(ctx, setting, edit),
      }),
    });
  }

  if (hidden > 0) {
    out.push(
      "",
      chalk.dim(`  ${hidden} more persona(s) do not fit at this width; Enter on a row lists all of them.`),
    );
  }
  out.push(
    "",
    chalk.dim("  improve is PER PERSONA (its own spec) · sandbox is PER SESSION (this terminal)"),
  );
  return out;
}

/**
 * An editor for one cell, supplied by the caller. Kept as an injected callback so this
 * module stays pure (it reads configuration, it does not know how to write it) while the
 * drill-down is still ACTIONABLE: any persona's setting can be changed without leaving it.
 */
export type CellEditor = (scope: PersonaScope, setting: MatrixSetting) => (() => TabAction | void) | undefined;

/**
 * One setting, every persona, vertically: value, owned-or-inherited, and the layer that
 * decided it. This is the view that scales, so it is the one that must be complete.
 */
export function settingDetailLines(ctx: Ctx, setting: MatrixSetting, edit?: CellEditor): TabLine[] {
  const scopes = personaScopes(ctx);
  const out: TabLine[] = [chalk.dim(`  ${MEANING[setting]}`), ""];
  const nameW = Math.max(6, ...scopes.map((s) => visibleWidth(s.label)));

  // EVERY persona is a row, editable or not. Mixing selectable rows with plain text made
  // the two render through different code paths in the host (one padded and prefixed with
  // a cursor, one not), so the same list came out misaligned depending on which personas
  // happened to be editable. Uniform rows also mean the cursor walks the persona list,
  // which is the natural thing to do in a list of personas.
  for (const scope of scopes) {
    const eff = settingFor(ctx, scope, setting);
    const marker = eff.own ? chalk.green("●") : chalk.dim("○");
    const onEnter = edit?.(scope, setting);
    out.push({
      label: `${"  ".repeat(scope.depth)}${marker} ${scope.label}`,
      value: eff.own ? chalk.white(eff.value) : chalk.dim(eff.value),
      hint: onEnter
        ? `Enter changes ${setting} for ${scope.label}`
        : eff.readonly ?? `${scope.label}: ${ORIGIN_TEXT[eff.origin]}`,
      ...(onEnter ? { onEnter } : {}),
    });
    // The origin sits UNDER the value, not under the name: the host paints a row as
    // 2 columns of cursor + a 14-column label + a space, so the value column starts at 17
    // and this continuation line has to start there too or the pair reads as two
    // unrelated lines.
    out.push(" ".repeat(VALUE_COL) + chalk.dim(`↳ ${ORIGIN_TEXT[eff.origin]}`));
  }

  const readonly = settingFor(ctx, scopes[0], setting).readonly;
  out.push("", chalk.dim("  ● this persona set it   ○ inherited"));
  if (readonly) out.push(chalk.yellow(`  ! ${readonly}`));
  else out.push(chalk.dim(`  change it: ${howToChange(setting)}`));
  return out;
}

/**
 * Every setting must come with the way to change it. The rule for warnings applies to
 * configuration too: showing a value without saying how to move it is half an answer.
 */
function howToChange(setting: MatrixSetting): string {
  switch (setting) {
    case "model":
      return "/model (here) · personaxis model set <name> --persona <slug|main> (outside)";
    case "improve":
      return "/improve (here) · personaxis improve <mode> --persona <slug|main> (outside)";
    case "memory":
      return "/memory (here) · edit memory.types in that persona's personaxis.md";
    case "hooks":
      return "/hooks (here) · personaxis compile --target <host> (outside)";
    case "sandbox":
      return "shift+tab cycles the session posture";
  }
}

/** Plain-text projection for the pipe/no-TTY path (no cursor, no drill). */
export function configMatrixText(ctx: Ctx): string[] {
  const out: string[] = [];
  for (const setting of MATRIX_SETTINGS) {
    out.push(chalk.bold(`  ${setting}`) + chalk.dim(`  ${MEANING[setting]}`));
    for (const scope of personaScopes(ctx)) {
      const eff = settingFor(ctx, scope, setting);
      out.push(`    ${scope.label.padEnd(14)} ${eff.value}  ${chalk.dim(`(${eff.own ? "own" : "inherited"}: ${eff.origin})`)}`);
    }
  }
  return out;
}

/** Exported for tests: the scopes a matrix would render. */
export function matrixScopes(ctx: Ctx): PersonaScope[] {
  return personaScopes(ctx);
}
