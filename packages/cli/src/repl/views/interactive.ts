/**
 * Interactive providers (V6.1): the Settings and Persona miniapps stop being
 * passive text. The data collectors (settings-data.ts, persona-data.ts) stay
 * the single source of truth for WHAT is shown (pipes print exactly the same
 * lines); this module wraps them with the host's typed rows so, inside the TUI,
 * values can be edited in place and dense sections drill down.
 *
 *   Settings > Config   Actions rows: sandbox posture, improve mode, default
 *                       model profile; Enter cycles the value and persists it
 *                       where it lives (ctx / persona spec / global config).
 *   Settings > Status   "inspect state" row drills into per-coordinate detail
 *                       (value, envelope, u, band, steps to cross).
 *   Settings > Usage    "by model" row drills into the per-model breakdown.
 *   Persona  > Anatomy  each of the ten layers is a row; Enter drills into the
 *                       layer's declared fields, straight from the spec.
 */

import chalk from "chalk";
import { loadPersona, stateOf,
  readState,
  extractEnvelopes,
  driftReport,
  readDriftThresholds,
  readMaxStepDelta,
} from "@personaxis/core";
import type { Ctx } from "../types.js";
import { POSTURES, notePostureChange } from "../config.js";
import { runMode, MODES, isMode } from "../../commands/improve.js";
import { loadConfig, saveConfig } from "../../config.js";
import { profileNames, setDefaultProfile } from "../../config-wizard.js";
import { settingsLines, SETTINGS_TABS, daemonLines } from "./settings-data.js";
import { personaLines, PERSONA_TABS, AURA_FRAME_MS } from "./persona-data.js";
import { discoverTree, type SubPersonaRef } from "../roster.js";
import { configMatrixLines, type CellEditor } from "./config-matrix.js";
import { settingFor, invalidateScopeCache } from "../scope.js";
import { scopedProvider } from "./scoped.js";
import type { TabbedProvider, TabLine, TabAction } from "./tabbed.js";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const LAYERS = [
  "identity",
  "character",
  "personality",
  "values_and_drives",
  "affect",
  "cognition",
  "memory",
  "metacognition",
  "self_regulation",
  "persona",
] as const;

/** Per-coordinate drill: the live value against its declared envelope. */
function stateDetailLines(ctx: Ctx): TabLine[] {
  const fm = ctx.handle.frontmatter as Record<string, unknown>;
  const st = stateOf(ctx.handle);
  if (!st) return [];
  const env = extractEnvelopes(ctx.handle.frontmatter);
  const report = driftReport({
    values: st.values,
    envelopes: env.envelopes,
    maxStepDelta: readMaxStepDelta(fm),
    thresholds: readDriftThresholds(fm),
    protectedFields: env.protectedFields,
  });
  const byField = new Map(report.coordinates.map((c) => [c.field, c]));
  const out: TabLine[] = [chalk.dim("  every live coordinate against its declared envelope"), ""];
  for (const [field, e] of Object.entries(env.envelopes)) {
    const v = st.values[field] ?? e.mean;
    const c = byField.get(field);
    out.push({
      label: field.split(".").slice(-1)[0],
      value:
        `${v.toFixed(2)}  ${chalk.dim(`[${e.min.toFixed(2)}..${e.max.toFixed(2)}] mean ${e.mean.toFixed(2)}`)}` +
        (c ? `  u ${c.u.toFixed(2)} ${c.band}` : ""),
      hint: `${field} · band ${c?.band ?? "-"} · Esc back`,
    });
  }
  return out;
}

/** Per-model drill for Settings > Usage. */
function byModelLines(ctx: Ctx): TabLine[] {
  const bm = ctx.usage.byModel ?? {};
  const names = Object.keys(bm);
  if (!names.length) return [chalk.dim("  no per-model usage recorded yet this session.")];
  const out: TabLine[] = [chalk.dim("  cumulative per-model usage, this session"), ""];
  for (const name of names) {
    const s = bm[name];
    out.push(
      `  ${chalk.cyan(name)}`,
      `    turns ${s.turns} · tokens ${s.tokens.toLocaleString()} · $${s.costUsd.toFixed(4)}`,
      "",
    );
  }
  return out;
}

/**
 * The Actions block appended to Settings > Config.
 *
 * The `posture` and `improve` rows are gone from here: the matrix above already owns both,
 * for EVERY persona rather than only the active one, and a second copy that silently
 * applied to just one of them is the kind of redundancy this surface exists to remove.
 * What remains is the one setting the matrix reports but does not own: the global default
 * model profile, which is a property of your configuration rather than of any persona.
 */
function configActionRows(ctx: Ctx): TabLine[] {
  const cfgGlobal = loadConfig("global");
  const profiles = profileNames(cfgGlobal);
  const currentProfile = cfgGlobal.defaultProfile ?? profiles[0];
  return [
    "",
    chalk.bold("  Actions"),
    ...(profiles.length > 1
      ? [
          {
            label: "default model",
            value: currentProfile,
            hint: "Enter cycles the global default profile (~/.personaxis/config.json)",
            onEnter: (): TabAction => {
              const i = Math.max(0, profiles.indexOf(currentProfile ?? ""));
              const next = profiles[(i + 1) % profiles.length];
              saveConfig(setDefaultProfile(loadConfig("global"), next), "global");
              return { kind: "toast", text: `default model profile → ${next}` };
            },
          } satisfies TabLine,
        ]
      : []),
  ];
}

/**
 * The matrix's cell editor (V7.C2/V7.C3). `improve` is per persona, so it is editable for
 * ANY persona from the drill-down, writing that persona's own personaxis.md; `sandbox` is
 * per session, so it is offered once and cycles the terminal's posture. The rest are
 * resolved through config layers whose editing has its own dedicated surface (/model,
 * /memory, /hooks), and pretending to edit them here would be editing an unknown layer.
 */
function matrixEditor(ctx: Ctx): CellEditor {
  return (scope, setting) => {
    if (setting === "improve") {
      return (): TabAction => {
        const current = settingFor(ctx, scope, "improve").value;
        const next = MODES[(MODES.indexOf(current as (typeof MODES)[number]) + 1) % MODES.length];
        if (!isMode(next)) return { kind: "toast", text: "unavailable" };
        try {
          const r = runMode(scope.personaPath, next);
          // The session's own mode only tracks the persona you are talking to.
          if (scope.address === "") ctx.mode = r.current;
          invalidateScopeCache(scope.personaPath);
          return { kind: "toast", text: `${scope.label}: improve → ${r.current}` };
        } catch (e) {
          return { kind: "toast", text: `could not set mode for ${scope.label}: ${(e as Error).message}` };
        }
      };
    }
    if (setting === "sandbox" && scope.address === "") {
      return (): TabAction => {
        ctx.postureIndex = (ctx.postureIndex + 1) % POSTURES.length;
        notePostureChange(ctx);
        return { kind: "toast", text: `sandbox posture → ${POSTURES[ctx.postureIndex]} (whole session)` };
      };
    }
    return undefined;
  };
}

/**
 * Settings provider (V6.1; scoped in V7.C1).
 *
 * Status and Stats answer for the SELECTED persona (its state, its drift, its sessions).
 * Config deliberately does not follow the selector: it already shows every persona at once
 * as a matrix, and scoping a matrix to one column would be a contradiction.
 * Usage stays session-wide because spend belongs to the terminal, not to a persona.
 */
export function settingsProvider(ctx: Ctx): TabbedProvider {
  return scopedProvider(ctx, (c) => ({
    title: "Settings",
    lines: (t): TabLine[] => {
      // Config (1) is the whole matrix and Usage (2) is the session's spend, so both read
      // the SESSION's context; Status (0) and Stats (3) follow the selected persona.
      const base: TabLine[] = settingsLines(t === 1 || t === 2 ? ctx : c, t);
      if (t === 0) {
        return [
          ...base,
          "",
          {
            label: "daemons",
            value: chalk.dim(
              Object.keys(c.bg ?? {}).filter((n) => c.bg?.[n]?.exitCode === null).join(", ") || "none running",
            ),
            hint: "Enter shows /serve and /watch: what each is for, its port, binding and uptime",
            onEnter: (): TabAction => ({ kind: "drill", title: "daemons", lines: () => daemonLines(c) }),
          },
          {
            label: "inspect state",
            value: chalk.dim("per-coordinate detail: value, envelope, u, band"),
            hint: "Enter opens the live-state drill-down",
            onEnter: (): TabAction => ({ kind: "drill", title: "state", lines: () => stateDetailLines(c) }),
          },
        ];
      }
      // V7.C2: Config leads with the MATRIX (every setting x every persona), then the
      // file locations, then the in-place actions. The old text-only list said what the
      // CURRENT session used and stayed silent about the sub-personas entirely.
      if (t === 1) {
        return [
          ...configMatrixLines(ctx, process.stdout.columns ?? 80, matrixEditor(ctx)),
          "",
          ...base,
          ...configActionRows(ctx),
        ];
      }
      if (t === 2 && Object.keys(ctx.usage.byModel ?? {}).length) {
        return [
          ...base,
          "",
          {
            label: "by model",
            value: chalk.dim("per-model turns, tokens and spend"),
            hint: "Enter opens the per-model breakdown",
            onEnter: (): TabAction => ({ kind: "drill", title: "by model", lines: () => byModelLines(ctx) }),
          },
        ];
      }
      return base;
    },
    tabs: [...SETTINGS_TABS],
  }));
}

/** V6.6: one sub-persona's card (the Sub-personas drill). */
function subDetailLines(sub: SubPersonaRef): TabLine[] {
  const cfg = loadConfig("global");
  const projectCfg = loadConfig("project");
  const profile = projectCfg.personas?.[sub.slug]?.profile ?? cfg.personas?.[sub.slug]?.profile;
  const out: TabLine[] = [
    chalk.dim(`  @${sub.address}`),
    "",
    `  ${chalk.cyan("spec".padEnd(10))} ${sub.path}`,
    `  ${chalk.cyan("model".padEnd(10))} ${profile ?? chalk.dim("(inherits the default profile)")}`,
  ];
  try {
    // Described from the record, and without creating anything: showing somebody a
    // sub-persona must not be what brings it into being.
    const st = stateOf(loadPersona(sub.path));
    out.push(
      st
        ? `  ${chalk.cyan("state".padEnd(10))} ${st.mutation_log.length} mutation(s) recorded`
        : `  ${chalk.cyan("state".padEnd(10))} ${chalk.dim("not initialized yet")}`,
    );
  } catch (e) {
    out.push(`  ${chalk.cyan("state".padEnd(10))} ${chalk.yellow((e as Error).message)}`);
  }
  out.push(
    "",
    chalk.bold("  How to use it"),
    `  ${chalk.cyan("talk")}      @${sub.address} <message>  (from the chat)`,
    `  ${chalk.cyan("everyone")}  @all <message>`,
    `  ${chalk.cyan("model")}     personaxis model set <name> --persona ${sub.slug}  (outside the app)`,
    chalk.dim("  personas read each other's files but never write them"),
  );
  return out;
}

/** V6.6: the Sub-personas tab as actionable rows (was a bare slug list). */
function subsRows(ctx: Ctx): TabLine[] {
  const subs = discoverTree(ctx.handle.personaPath);
  const out: TabLine[] = [
    chalk.dim("  where you are and every persona you can reach from here"),
    "",
    {
      label: "main",
      value: `${ctx.name}  ${chalk.dim("(this session)")}`,
      hint: "you are talking to the main persona; @<slug> addresses a sub for one message",
    },
  ];
  for (const s of subs) {
    out.push({
      label: `@${s.address}`,
      value: chalk.dim("Enter: model, state and how to talk to it"),
      hint: `address it from the chat: @${s.address} <message>`,
      onEnter: (): TabAction => ({ kind: "drill", title: `@${s.address}`, lines: () => subDetailLines(s) }),
    });
  }
  out.push("", {
    label: "new sub",
    value: chalk.dim("create a sub-persona under .personaxis/personas/"),
    hint: "runs the Genesis wizard",
    onEnter: (): TabAction => ({ kind: "toast", text: "close this view and run /create (pick Sub-persona)" }),
  });
  return out;
}

/** One layer's declared fields, straight from the spec (the Anatomy drill). */
function layerDetailLines(ctx: Ctx, layer: string): TabLine[] {
  const fm = ctx.handle.frontmatter as Record<string, unknown>;
  const node = fm[layer];
  if (node === undefined) return [chalk.dim(`  ${layer}: not declared in this spec.`)];
  const out: TabLine[] = [chalk.dim(`  ${layer} as declared in personaxis.md`), ""];
  const walk = (v: unknown, indent: string, key?: string): void => {
    if (out.length > 200) return; // keep the drill bounded
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      if (key) out.push(`${indent}${chalk.cyan(key)}`);
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) walk(val, key ? indent + "  " : indent, k);
      return;
    }
    const shown = Array.isArray(v) ? `[${v.map((x) => (typeof x === "object" ? "…" : String(x))).join(", ")}]` : String(v);
    out.push(`${indent}${chalk.cyan(key ?? "")} ${shown.length > 80 ? shown.slice(0, 77) + "…" : shown}`);
  };
  walk(node, "  ");
  return out;
}

/**
 * Persona provider (V6.1; scoped in V7.C1): Anatomy becomes ten drillable layer rows, and
 * the whole view answers for WHICHEVER persona the selector points at, main or any sub.
 * The selection lives here, in the provider's closure, so it survives tab changes,
 * drill-downs and the animation's redraws.
 */
export function personaProvider(ctx: Ctx): TabbedProvider {
  return scopedProvider(ctx, (c) => ({
    title: "Persona",
    tabs: [...PERSONA_TABS],
    // The aura lives in this view, so it drives the host's redraw rate (V7.D8).
    tickMs: AURA_FRAME_MS,
    lines: (t): TabLine[] => {
      // Sub-personas are listed relative to the persona in focus, so drilling into a sub
      // and then opening its own Sub-personas tab keeps descending the real tree.
      if (t === 3) return subsRows(c);
      if (t !== 1) return personaLines(c, t);
      const fm = c.handle.frontmatter as Record<string, unknown>;
      const out: TabLine[] = [
        chalk.dim("  the ten canonical layers of this persona's anatomy (spec: personaxis.md)"),
        "",
      ];
      LAYERS.forEach((layer, i) => {
        const declared = fm[layer] !== undefined;
        out.push({
          label: `${i + 1} ${layer}`,
          value: declared ? chalk.dim("declared · Enter to inspect") : chalk.dim("(not declared)"),
          hint: `Enter opens the ${layer} layer as declared in the spec`,
          onEnter: declared
            ? (): TabAction => ({ kind: "drill", title: layer, lines: () => layerDetailLines(c, layer) })
            : undefined,
        });
      });
      return out;
    },
  }));
}
