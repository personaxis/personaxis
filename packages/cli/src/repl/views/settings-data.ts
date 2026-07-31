/**
 * Settings miniapp data collectors (V5.P1.2): Status / Config / Usage / Stats as
 * plain chalk-colored lines, consumed BOTH by the tabbed view inside the TUI and
 * by the /status /usage /config /cost text fallbacks in pipe mode, so there is
 * exactly one source of truth per tab.
 */

import chalk from "chalk";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import {
  readState,
  extractEnvelopes,
  driftReport,
  readDriftThresholds,
  readMaxStepDelta,
  readMemoryTypes,
  activeOverlay,
  proposals,
  listSessions,
  readStatsCache,
} from "@personaxis/core";
import { lineChart, heatmapGitHub } from "@personaxis/tui/visual";
import { slugAddressFromPath, compiledPathFor } from "../../load.js";
import type { Ctx } from "../types.js";
import { POSTURES, llmConfig, ctxModelArg, appraiserLabel } from "../config.js";
import { fmtK, meterBar } from "../render.js";
import { version } from "../../generated/assets.js";

const row = (label: string, value: string): string => `  ${chalk.cyan(label.padEnd(12))} ${value}`;

/** Settings > Status: the session snapshot + the live state surface (absorbs /state). */
export function statusLines(ctx: Ctx): string[] {
  const fm = ctx.handle.frontmatter as Record<string, unknown>;
  const st = readState(ctx.handle.statePath);
  const env = extractEnvelopes(ctx.handle.frontmatter);
  const report = driftReport({
    values: st.values,
    envelopes: env.envelopes,
    maxStepDelta: readMaxStepDelta(fm),
    thresholds: readDriftThresholds(fm),
    protectedFields: env.protectedFields,
  });
  const over = report.layers.filter((l) => l.exceeded).map((l) => l.layer);
  const types = readMemoryTypes(fm);
  const onKinds = (Object.entries(types) as [string, boolean][]).filter(([, v]) => v).map(([k]) => k);
  const m = ctx.meter;
  const address = slugAddressFromPath(ctx.handle.personaPath);
  const overlay = activeOverlay(ctx.handle.personaPath);
  const pending = proposals(ctx.handle.personaPath).filter((x) => x.status === "pending");

  const lines: string[] = [
    row("version", `personaxis ${version}`),
    row("persona", `${ctx.name}  ${chalk.dim(address ? `@${address}` : "(main persona)")}`),
    row("session", `${ctx.sessionId}${ctx.sessionStarted ? "" : chalk.dim(" (not yet written)")}`),
    row("cwd", process.cwd()),
    row("model", appraiserLabel(ctxModelArg(ctx))),
    row("posture", `${POSTURES[ctx.postureIndex]}  ·  improve: ${ctx.mode}`),
    row("drift", `D ${report.global.toFixed(3)}` + (over.length ? chalk.red(`  ⚠ over: ${over.join(", ")}`) : chalk.green("  within thresholds"))),
    row("memory", onKinds.join(", ") || "(none enabled)"),
    row("context", m.limit ? `${fmtK(m.used)}/${fmtK(m.limit)} (${Math.round(m.pct * 100)}%)  ·  ${m.elapsedSeconds.toFixed(0)}s` : chalk.dim("offline (no model)")),
    row("mutations", String(st.mutation_log.length)),
  ];
  // The live-envelope block used to be printed here AND in /drift, which made the two
  // commands look like the same screen. They answer different questions: /status is the
  // snapshot of what this persona is right now, /drift is the delta against what it
  // declared. The drift line above carries the one number Status needs; the coordinates
  // live in /drift.
  lines.push("", chalk.dim("  coordinate-by-coordinate movement lives in /drift (three planes)"));
  if (Object.keys(overlay).length || pending.length) {
    lines.push("", chalk.bold("  Self-edits"));
    if (Object.keys(overlay).length) lines.push(`  ${chalk.green("applied")}  ${Object.keys(overlay).length} field(s): ${Object.keys(overlay).slice(0, 4).join(", ")}${Object.keys(overlay).length > 4 ? ", …" : ""}`);
    if (pending.length) lines.push(`  ${chalk.yellow("pending")}  ${pending.length} proposal(s) · /review to decide`);
  }
  return lines;
}

/** Settings > Config: effective configuration and where each value comes from. */
export function configLines(ctx: Ctx): string[] {
  const llm = llmConfig(ctxModelArg(ctx));
  const fm = ctx.handle.frontmatter as Record<string, unknown>;
  const globalCfg = join(homedir(), ".personaxis", "config.json");
  const projectCfg = join(process.cwd(), ".personaxis", "config.json");
  const envOverride = process.env.PERSONAXIS_MODEL || process.env.PERSONAXIS_ENDPOINT;
  const types = readMemoryTypes(fm);
  return [
    chalk.bold("  Model"),
    row("resolved", llm ? `${llm.model} @ ${llm.endpoint}` : chalk.dim("(none, offline)")),
    row("via", envOverride ? "environment (PERSONAXIS_*)" : "config layers (global < project < persona < frontmatter)"),
    row("global", existsSync(globalCfg) ? globalCfg : chalk.dim(`${globalCfg} (absent)`)),
    row("project", existsSync(projectCfg) ? projectCfg : chalk.dim(`${projectCfg} (absent)`)),
    "",
    chalk.bold("  Session behavior"),
    row("posture", POSTURES[ctx.postureIndex]),
    row("improve", ctx.mode),
    row("memory", (Object.entries(types) as [string, boolean][]).map(([k, v]) => `${k}:${v ? "on" : "off"}`).join(" ")),
    "",
    chalk.dim("  /model opens the model selector · /improve sets the self-improvement mode"),
  ];
}

/** Settings > Usage: this session's spend, context and per-model breakdown (absorbs /cost). */
export function usageLines(ctx: Ctx): string[] {
  const u = ctx.usage;
  const m = ctx.meter;
  const lines: string[] = [
    chalk.bold("  Session"),
    row("cost", `$${u.costUsd.toFixed(4)}${u.turns ? chalk.dim(`  · ~$${(u.costUsd / u.turns).toFixed(4)}/turn`) : ""}`),
    row("turns", `${u.turns}  ${chalk.dim(`(${u.steps} agent step(s))`)}`),
    row("tokens", u.tokens.toLocaleString()),
    row("elapsed", `${m.elapsedSeconds.toFixed(0)}s`),
    "",
    chalk.bold("  Context window"),
    m.limit
      ? `  ${meterBar(m.pct, 24)}  ${fmtK(m.used)}/${fmtK(m.limit)}  ${Math.round(m.pct * 100)}%`
      : chalk.dim("  offline (no model configured)"),
  ];
  const bm = u.byModel ?? {};
  const models = Object.keys(bm);
  if (models.length) {
    lines.push("", chalk.bold("  Usage by model"));
    for (const name of models) {
      const s = bm[name];
      lines.push(`  ${chalk.cyan(name)}  ${s.turns} turn(s) · ${s.tokens.toLocaleString()} tok · $${s.costUsd.toFixed(4)}`);
    }
  }
  lines.push("", chalk.dim("  BYOK: spend is computed from the active profile's pricing; there are no account limits here."));
  return lines;
}

/** Settings > Stats: local activity across this persona's saved sessions. */
export function statsLines(ctx: Ctx): string[] {
  const sessions = listSessions(ctx.handle.personaPath);
  if (!sessions.length) return [chalk.dim("  no saved sessions yet; stats accumulate as you talk.")];
  const days = new Map<string, number>(); // yyyy-mm-dd -> turns
  for (const s of sessions) {
    const day = (s.updated || s.created).slice(0, 10);
    days.set(day, (days.get(day) ?? 0) + s.turns);
  }
  const totalTurns = sessions.reduce((n, s) => n + s.turns, 0);
  // Streaks over calendar days with any activity.
  const sorted = [...days.keys()].sort();
  let longest = 0;
  let current = 0;
  let prev: string | null = null;
  for (const d of sorted) {
    if (prev && Date.parse(d) - Date.parse(prev) === 86_400_000) current += 1;
    else current = 1;
    longest = Math.max(longest, current);
    prev = d;
  }
  const today = new Date().toISOString().slice(0, 10);
  const activeToday = days.has(today);
  // V6.4: real charts, one tested module (@personaxis/tui charts).
  const weeks = 12;
  const lines: string[] = [chalk.bold(`  Activity (last ${weeks} weeks)`), ...heatmapGitHub(days, weeks)];
  const N = 30;
  const startD = new Date();
  startD.setDate(startD.getDate() - (N - 1));
  const points: number[] = [];
  for (let i = 0; i < N; i++) {
    const d = new Date(startD);
    d.setDate(startD.getDate() + i);
    points.push(days.get(d.toISOString().slice(0, 10)) ?? 0);
  }
  lines.push(
    "",
    chalk.bold("  Turns per day (last 30 days)"),
    ...lineChart([{ label: "turns", points, color: 6 }], { height: 6, xLabels: ["30d ago", "today"] }),
  );
  // V6.10: tokens/day per model, from the global stats cache (~/.personaxis/
  // stats-cache.json, fed at session close), instant and cross-project.
  const cache = readStatsCache();
  const cacheDays = Object.keys(cache.days).sort();
  if (cacheDays.length) {
    const models = [...new Set(cacheDays.flatMap((d) => Object.keys(cache.days[d])))].slice(0, 4);
    const series = models.map((m, i) => ({
      label: m,
      color: [6, 5, 3, 4][i % 4],
      points: Array.from({ length: N }, (_, k) => {
        const d = new Date(startD);
        d.setDate(startD.getDate() + k);
        return cache.days[d.toISOString().slice(0, 10)]?.[m]?.tokens ?? 0;
      }),
    }));
    lines.push(
      "",
      chalk.bold("  Tokens per day by model (last 30 days)"),
      ...lineChart(series, { height: 6, xLabels: ["30d ago", "today"] }),
    );
  }
  lines.push(
    "",
    row("sessions", String(sessions.length)),
    row("turns", String(totalTurns)),
    row("active days", String(days.size)),
    row("streak", `${longest} day(s) longest${activeToday ? " · active today" : ""}`),
    row("latest", sessions[0] ? `${sessions[0].name || sessions[0].id} · ${sessions[0].updated.slice(0, 16).replace("T", " ")}` : "-"),
  );
  return lines;
}

export const SETTINGS_TABS = ["Status", "Config", "Usage", "Stats"] as const;

export function settingsLines(ctx: Ctx, tab: number): string[] {
  switch (tab) {
    case 1:
      return configLines(ctx);
    case 2:
      return usageLines(ctx);
    case 3:
      return statsLines(ctx);
    default:
      return statusLines(ctx);
  }
}

/**
 * Settings > Status > Daemons: the background processes this session owns.
 *
 * `/serve` and `/watch` used to be two commands whose purpose was not written down
 * anywhere, so knowing what they were for meant reading the source. They are one screen
 * now, and every row leads with WHAT IT IS FOR before any number.
 */
export function daemonLines(ctx: Ctx): string[] {
  const names = Object.keys(ctx.bg ?? {}).filter((n) => ctx.bg?.[n]?.exitCode === null);
  const out: string[] = [
    chalk.dim("  background processes this session started; they stop when you /exit"),
    "",
  ];
  if (!names.length) {
    out.push(
      chalk.dim("  none running."),
      "",
      `  ${chalk.cyan("/serve")}  lets OTHER tools read this persona over HTTP (compiled identity, state,`,
      chalk.dim("          audit) without opening the CLI. Binds to 127.0.0.1; exposing it beyond"),
      chalk.dim("          localhost requires an explicit --host AND a --token."),
      `  ${chalk.cyan("/watch")}  keeps the compiled PERSONA.md fresh, so host agents reading the file`,
      chalk.dim("          never see a stale persona after a spec edit or a drift."),
    );
    return out;
  }
  for (const name of names) {
    const child = ctx.bg![name];
    const info = ctx.daemonInfo?.[name];
    out.push(`  ${chalk.green("●")} ${chalk.bold(name)}  ${chalk.dim(info?.purpose ?? "")}`);
    const facts: string[] = [`pid ${child.pid}`];
    if (info) {
      const secs = Math.max(0, Math.round((Date.now() - info.startedAt) / 1000));
      facts.push(`up ${secs < 60 ? `${secs}s` : `${Math.round(secs / 60)}m`}`);
      if (info.port) facts.push(`port ${info.port}`);
      if (info.host) facts.push(`bound to ${info.host}`);
      facts.push(info.tokenRequired ? chalk.green("token required") : chalk.dim("no token (local only)"));
    }
    out.push(`      ${chalk.dim(facts.join("  ·  "))}`);
    out.push(chalk.dim(`      /${name} stop to stop it`));
  }
  return out;
}
