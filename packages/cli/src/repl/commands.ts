/**
 * REPL slash-command registry + dispatch (F3.6 split).
 *
 * The single source of truth for the `/` menu and `/help`: every command's name,
 * description, and handler. `runCommand` dispatches a `/line` to its handler, or
 * falls through to a `personaxis <name>` subprocess so every CLI subcommand is
 * reachable from inside the app.
 */

import chalk from "chalk";
import { relative, dirname, join } from "node:path";
import { existsSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import {
  readState,
  extractEnvelopes,
  driftReport,
  readDriftThresholds,
  readMaxStepDelta,
  rebuildStateValues,
  resolveField,
  readArbitrationValues,
  arbitrate,
  rankValues,
  activeOverlay,
  proposals,
  readMemory,
  readMemoryTypes,
  readSemanticMemory,
  readProcedural,
  readAutobiographical,
  readPreferences,
  readEvaluations,
  applySelfEdit,
  rejectSelfEdit,
  verifyMemoryChain,
  overseerView,
  readRecompilePending,
  displayName,
  readMode,
  compactMessages,
  recordCompaction,
  loadConversation,
  listSessions,
  findSession,
  renameSession,
} from "@personaxis/core";
import { sigilLines, envelopeBars } from "@personaxis/tui/visual";
import { renderFrame } from "@personaxis/tui";
import type { SlashItem } from "@personaxis/tui/screen";
import { isSubagentPath, slugAddressFromPath, loadPersonaFile } from "../load.js";
import { runMode, isMode, MODES } from "../commands/improve.js";
import { runCompile } from "../commands/compile.js";
import { setModelSetting } from "../config.js";
import { installHook, HOSTS } from "../commands/hooks.js";
import { validatePersona } from "../schema.js";
import { lint } from "../linter/index.js";
import { writeStarterPersona } from "../starter.js";
import { buildResourceManifest } from "../resource-manifest.js";
import { discoverTree } from "./roster.js";
import type { Ctx, CommandDef } from "./types.js";
import { POSTURES, llmConfig, ctxModelArg, appraiserLabel, notePostureChange, readGoalText } from "./config.js";
import { stopDaemons, startStopDaemon, runCliPassthrough } from "./daemons.js";
import { ensureCtxSession } from "./session.js";
import { maybeRecompile } from "./turn.js";

// ── Commands (single source for /help and the live `/` menu) ─────────────────
export const COMMANDS: CommandDef[] = [
  { name: "help", desc: "show commands", run: (_a, ctx) => void ctx.out(helpText()) },
  {
    name: "persona",
    desc: "identity, role, sub-personas, resources + sigil",
    run: (_a, ctx) => {
      const p = ctx.handle.personaPath;
      const id = ctx.handle.frontmatter.identity as { display_name?: string; system_identity?: { purpose?: string } } | undefined;
      const address = slugAddressFromPath(p);
      const role = isSubagentPath(p) && address ? `sub-persona @${address}` : "root persona";
      ctx.out(chalk.bold(`  ${ctx.name}`) + chalk.dim(`  · ${role}`));
      if (id?.system_identity?.purpose) ctx.out(`  ${chalk.dim("purpose:")} ${id.system_identity.purpose}`);
      ctx.out(chalk.dim(`  improve: ${ctx.mode} · sandbox: ${POSTURES[ctx.postureIndex]}`));
      // sub-personas this persona can delegate to
      const subs = discoverTree(p);
      if (subs.length) {
        ctx.out(chalk.bold("  Sub-personas"));
        for (const s of subs) ctx.out(`  ${"  ".repeat(s.depth - 1)}${chalk.cyan(`@${s.address}`)}`);
      }
      // resource inventory beside the spec
      const manifest = buildResourceManifest(dirname(p));
      if (manifest.trim()) {
        ctx.out(chalk.bold("  Resources"));
        for (const line of manifest.split("\n")) ctx.out(`  ${chalk.dim(line.replace(/^- /, ""))}`);
      }
      // the living sigil (sober microdetail)
      ctx.out(sigilLines(ctx.theme, readState(ctx.handle.statePath).values).join("\n"));
      ctx.out(chalk.dim(`  seed #${ctx.theme.seed.toString(16)} · voice ${ctx.theme.voice.density}`));
    },
  },
  {
    name: "dash",
    desc: "snapshot of the living dashboard (sigil + envelopes + memory chain)",
    run: (_a, ctx) => {
      // A single inline frame — the REPL owns the TTY, so we don't take over the screen.
      // For the animated live view, run `personaxis dash` in a second terminal.
      for (const line of renderFrame(ctx.handle.personaPath, 0).split("\n")) ctx.out(line);
      ctx.out(chalk.dim(`  live view: `) + chalk.cyan(`personaxis dash -p ${relative(process.cwd(), ctx.handle.personaPath) || ctx.handle.personaPath}`) + chalk.dim(" (second terminal — animates as this session evolves)"));
    },
  },
  {
    name: "state",
    desc: "live mutable surface: envelopes + applied self-edits + pending proposals",
    run: (_a, ctx) => {
      const p = ctx.handle.personaPath;
      const st = readState(ctx.handle.statePath);
      const env = extractEnvelopes(ctx.handle.frontmatter);
      // (1) quantitative — the numeric envelope state.
      ctx.out(chalk.bold("  Envelope values") + chalk.dim("  (quantitative)"));
      ctx.out(envelopeBars(ctx.theme, st.values, env.envelopes));
      ctx.out(chalk.dim(`  mutation_log: ${st.mutation_log.length} entries`));
      // (2) qualitative — self-edits already APPLIED to the spec (the overlay). This is the rest of
      // the mutable surface beyond the 9 numbers: any non-protected section may live here now.
      const overlay = activeOverlay(p);
      const keys = Object.keys(overlay);
      ctx.out(chalk.bold("  Applied self-edits") + chalk.dim("  (qualitative overlay)"));
      if (!keys.length) ctx.out(chalk.dim("  (none) — no spec section has self-evolved yet"));
      else for (const k of keys) ctx.out(`  ${chalk.cyan(k)} ${chalk.dim("→ " + JSON.stringify(overlay[k]).slice(0, 72))}`);
      // (3) governance queue — proposals awaiting /review.
      const pending = proposals(p).filter((x) => x.status === "pending");
      if (pending.length) ctx.out(chalk.yellow(`  ${pending.length} pending proposal(s)`) + chalk.dim(" — /review"));
    },
  },
  {
    name: "drift",
    desc: "drift metric: u per coordinate, bands, layer thresholds, steps-to-cross (T3)",
    run: (_a, ctx) => {
      const st = readState(ctx.handle.statePath);
      const fm = ctx.handle.frontmatter as Record<string, unknown>;
      const env = extractEnvelopes(ctx.handle.frontmatter);
      const report = driftReport({
        values: st.values,
        envelopes: env.envelopes,
        maxStepDelta: readMaxStepDelta(fm),
        thresholds: readDriftThresholds(fm),
        protectedFields: env.protectedFields,
      });
      ctx.out(
        chalk.bold("  Drift") +
          chalk.dim(`  D = ${report.global.toFixed(3)} (max |u|) · δ_max ${report.maxStepDelta}`),
      );
      for (const c of report.coordinates) {
        const dir = c.u > 0 ? "+" : c.u < 0 ? "−" : " ";
        ctx.out(
          `  ${chalk.cyan(c.field.padEnd(36))} u ${dir}${Math.abs(c.u).toFixed(2)} ` +
            `${chalk.bold(c.band.padEnd(8))}` +
            (c.protected
              ? chalk.magenta(" immutable")
              : chalk.dim(` ≥${c.minStepsToCross} step(s) to cross`)),
        );
      }
      for (const l of report.layers) {
        if (l.threshold === undefined) continue;
        const mark = l.exceeded ? chalk.red("✗ over threshold") : chalk.green("✓");
        ctx.out(`  ${mark} ${l.layer}: D ${l.drift.toFixed(3)} / ${l.threshold}`);
      }
    },
  },
  {
    name: "replay",
    desc: "replay the mutation_log as an animated trajectory (T4: state is a fold of history)",
    run: async (arg, ctx) => {
      const st = readState(ctx.handle.statePath);
      const env = extractEnvelopes(ctx.handle.frontmatter);
      const log = st.mutation_log;
      if (!log.length) return void ctx.out(chalk.dim("  mutation_log is empty — nothing to replay"));
      const last = Math.max(1, Math.min(log.length, Number(arg.trim()) || 30));
      const slice = log.slice(-last);
      const values: Record<string, number> = {};
      for (const [k, e] of Object.entries(env.envelopes)) values[k] = e.mean;
      for (const e of log.slice(0, log.length - last)) values[e.field] = e.to; // fast-forward the prefix
      ctx.out(chalk.bold(`  Replaying ${slice.length}/${log.length} mutation(s)`) + chalk.dim("  (each line is one audited entry)"));
      const animate = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
      for (const entry of slice) {
        values[entry.field] = entry.to;
        // Legacy logs use short keys (mood.tone); resolve onto the v1.0 envelope.
        const e = env.envelopes[resolveField(entry.field, env.envelopes)];
        const short = entry.field.split(".").pop() ?? entry.field;
        const marks = e
          ? (() => {
              const w = 20;
              const frac = e.max === e.min ? 0.5 : (entry.to - e.min) / (e.max - e.min);
              const pos = Math.max(0, Math.min(w - 1, Math.round(frac * (w - 1))));
              return "·".repeat(pos) + chalk.bold("●") + "·".repeat(w - 1 - pos);
            })()
          : "";
        ctx.out(
          `  ${chalk.dim(entry.ts.slice(11, 19))} ${chalk.cyan(short.padEnd(14))} ${entry.from.toFixed(2)}→${entry.to.toFixed(2)} [${marks}] ` +
            (entry.governance_blocked ? chalk.red("blocked") : entry.clamped ? chalk.yellow("clamped") : chalk.dim(entry.actor)) +
            chalk.dim(` ${entry.reason.slice(0, 34)}`),
        );
        if (animate) await new Promise((r) => setTimeout(r, 90));
      }
      const rebuilt = rebuildStateValues(env.envelopes, log, st.values);
      ctx.out(
        rebuilt.drift.length === 0
          ? chalk.green("  ✓ replay reproduces the live state exactly (T4)")
          : chalk.red(`  ✗ ${rebuilt.drift.length} field(s) diverge from the log — run \`personaxis state rebuild\``),
      );
    },
  },
  {
    name: "arbitrate",
    desc: "resolve a value conflict: /arbitrate <a> <b> — or no args for the full ranking",
    run: (arg, ctx) => {
      const values = readArbitrationValues(ctx.handle.frontmatter as Record<string, unknown>);
      if (!values.length) return void ctx.out(chalk.dim("  no weighted values declared"));
      const [a, b] = arg.trim().split(/\s+/).filter(Boolean);
      if (!a || !b) {
        ctx.out(chalk.bold("  Arbitration ranking") + chalk.dim("  governance ≻ weight ≻ name"));
        rankValues(values).forEach((v, i) => {
          const gov = v.type === "governance" ? chalk.magenta(" governance") : "";
          ctx.out(`  ${String(i + 1).padStart(2)}. ${chalk.cyan(v.name)} ${chalk.dim(String(v.weight))}${gov}`);
        });
        return;
      }
      const va = values.find((v) => v.name === a);
      const vb = values.find((v) => v.name === b);
      if (!va || !vb) {
        return void ctx.out(
          chalk.red(`  unknown value '${!va ? a : b}'`) + chalk.dim(` — declared: ${values.map((v) => v.name).join(", ")}`),
        );
      }
      const verdict = arbitrate(va, vb);
      ctx.out(`  ${chalk.green("✓")} ${chalk.bold(verdict.winner)} prevails ${chalk.dim(`(${verdict.rule})`)}`);
      ctx.out(chalk.dim(`  ${verdict.trace}`));
    },
  },
  {
    name: "improve",
    desc: "view/set self-improvement mode: locked | suggesting | autonomous",
    run: (arg, ctx) => {
      const wanted = arg.trim().toLowerCase();
      if (!wanted) {
        ctx.out(chalk.dim(`  improvement mode = ${chalk.bold(ctx.mode)}  ·  usage: /improve <${MODES.join("|")}>`));
        return;
      }
      if (!isMode(wanted)) {
        ctx.out(chalk.yellow(`  mode must be one of ${MODES.join(" | ")}`));
        return;
      }
      try {
        const r = runMode(ctx.handle.personaPath, wanted);
        ctx.mode = r.current;
        ctx.out(chalk.green(`  ✓ improvement mode → ${chalk.bold(ctx.mode)}`) + (r.changed ? "" : chalk.dim(" (unchanged)")));
      } catch (e) {
        ctx.out(chalk.red(`  could not set mode: ${(e as Error).message}`));
      }
    },
  },
  {
    name: "review",
    desc: "review queued self-edits: /review [approve|reject] <id|all>",
    run: async (arg, ctx) => {
      const p = ctx.handle.personaPath;
      const pending = proposals(p).filter((x) => x.status === "pending");
      const [verb, which] = arg.trim().split(/\s+/).filter(Boolean);
      if (!verb) {
        if (!pending.length) return void ctx.out(chalk.dim("  no pending self-edit proposals."));
        ctx.out(chalk.bold(`  Pending self-edits (${pending.length})`));
        for (const x of pending) {
          ctx.out(`  ${chalk.cyan(x.id)} ${chalk.dim(x.targetPath)}`);
          ctx.out(`     → ${chalk.dim(JSON.stringify(x.toValue).slice(0, 100))}`);
          ctx.out(`     ${chalk.dim(x.rationale)}`);
        }
        ctx.out(chalk.dim("  /review approve <id|all>  ·  /review reject <id|all>"));
        return;
      }
      if (verb !== "approve" && verb !== "reject") return void ctx.out(chalk.yellow("  usage: /review [approve|reject] <id|all>"));
      if (!which) return void ctx.out(chalk.yellow(`  usage: /review ${verb} <id|all>`));
      const targets = which === "all" ? pending : pending.filter((x) => x.id === which);
      if (!targets.length) return void ctx.out(chalk.yellow(`  no pending proposal "${which}" — see /review`));
      let approved = 0;
      for (const x of targets) {
        try {
          if (verb === "approve") {
            const r = applySelfEdit(p, x.id, "user");
            approved++;
            ctx.out(chalk.green(`  ✓ applied ${x.id}`) + chalk.dim(` ${x.targetPath} → v${r.version}`));
          } else {
            rejectSelfEdit(p, x.id, "user");
            ctx.out(chalk.dim(`  ✗ rejected ${x.id} ${x.targetPath}`));
          }
        } catch (e) {
          ctx.out(chalk.red(`  ${x.id}: ${(e as Error).message}`));
        }
      }
      if (approved > 0) await maybeRecompile(ctx);
    },
  },
  {
    name: "compile",
    desc: "recompile PERSONA.md from the (evolved) spec — explicit, may take a moment",
    run: async (_a, ctx) => {
      if (!readRecompilePending(ctx.handle.personaPath).pending) {
        return void ctx.out(chalk.dim("  PERSONA.md is already up to date."));
      }
      if (!llmConfig(ctxModelArg(ctx))) return void ctx.out(chalk.dim("  needs a model — configure with /model or `personaxis config set --global local.endpoint/model`."));
      ctx.out(chalk.dim("  recompiling PERSONA.md from the evolved spec…"));
      await maybeRecompile(ctx);
    },
  },
  {
    name: "audit",
    desc: "mutation log + memory-chain integrity + self-edit ledger + recent evaluations",
    run: (_a, ctx) => {
      const p = ctx.handle.personaPath;
      const st = readState(ctx.handle.statePath);
      const chain = verifyMemoryChain(p);
      ctx.out(chalk.bold("  Mutation log (last 8)"));
      for (const m of st.mutation_log.slice(-8)) ctx.out(`  ${chalk.dim(m.ts)} ${m.field}: ${m.from} → ${m.to}${m.clamped ? chalk.yellow(" clamped") : ""}`);
      ctx.out("  memory chain: " + (chain.ok ? chalk.green("intact ✓") : chalk.red(`broken at #${chain.brokenAt}`)));
      // self-edit ledger — what the persona changed about ITSELF, and the governance verdict.
      const all = proposals(p);
      if (all.length) {
        ctx.out(chalk.bold("  Self-edit ledger (last 6)"));
        for (const x of all.slice(-6)) {
          const c = x.status === "applied" ? chalk.green : x.status === "pending" ? chalk.yellow : chalk.red;
          ctx.out(`  ${chalk.dim(x.id)} ${c(x.status)} ${chalk.dim(x.targetPath)}`);
        }
      }
      // evaluations — quality/utility scores, with the target + dimension + score that "+N eval(s)" hid.
      const evals = readEvaluations(p);
      if (evals.length) {
        ctx.out(chalk.bold(`  Evaluations (${evals.length}, last 6)`));
        for (const ev of evals.slice(-6)) {
          const c = ev.score >= 0.66 ? chalk.green : ev.score >= 0.33 ? chalk.yellow : chalk.red;
          ctx.out(`  ${chalk.dim(ev.target)} ${ev.dimension} ${c(ev.score.toFixed(2))} ${chalk.dim(ev.rationale)}`);
        }
      }
    },
  },
  {
    name: "memory",
    desc: "all declared memory kinds: episodic, semantic, procedural, autobiographical, preferences, evaluations",
    run: (_a, ctx) => {
      const p = ctx.handle.personaPath;
      const types = readMemoryTypes(ctx.handle.frontmatter as Record<string, unknown>);
      // A small helper: a header + recent rows, or a one-line "(off)" / "(empty)" note per kind.
      const section = (label: string, enabled: boolean, rows: string[]): void => {
        if (!enabled) return void ctx.out(chalk.bold(`  ${label}`) + chalk.dim("  (off in memory.types)"));
        ctx.out(chalk.bold(`  ${label}`) + chalk.dim(`  (${rows.length})`));
        if (!rows.length) return void ctx.out(chalk.dim("  (empty)"));
        for (const r of rows.slice(-4)) ctx.out(`  ${r}`);
      };
      const epi = readMemory(p);
      section("Episodic", types.episodic, epi.map((m) => `${chalk.dim(m.ts.slice(0, 19))} ${chalk.cyan(`[${m.source}]`)} ${m.content.slice(0, 64)}`));
      // semantic lives in memory.md (consolidated); show the first few non-empty lines.
      const sem = readSemanticMemory(p).split("\n").map((l) => l.trim()).filter(Boolean).map((l) => chalk.dim(l.slice(0, 70)));
      section("Semantic (memory.md)", types.semantic, sem);
      section("Procedural", types.procedural, readProcedural(p).map((x) => `${chalk.dim(x.ts.slice(0, 19))} ${x.task.slice(0, 40)} → ${chalk.dim(x.procedure.slice(0, 40))}`));
      section("Autobiographical", types.autobiographical, readAutobiographical(p).map((x) => `${chalk.dim(x.ts.slice(0, 19))} ${x.event}${x.detail ? chalk.dim(`: ${x.detail.slice(0, 40)}`) : ""}`));
      const prefs = Object.entries(readPreferences(p));
      section("User preferences", types.user_preferences, prefs.map(([k, v]) => `${chalk.cyan(k)} = ${v.value.slice(0, 50)}`));
      section("Evaluations", types.evaluations, readEvaluations(p).map((ev) => `${chalk.dim(ev.target)} ${ev.dimension} ${ev.score.toFixed(2)} ${chalk.dim(ev.rationale.slice(0, 40))}`));
    },
  },
  {
    name: "overseer",
    desc: "cross-machine/project registry view (optional infra)",
    run: (_a, ctx) => {
      const v = overseerView();
      ctx.out(chalk.bold.magentaBright("  overseer") + chalk.dim(` · machine ${v.machine}`));
      ctx.out(`  personas ${v.personas} · projects ${v.projects} · collections ${v.collections}`);
      if (v.personas === 0 && v.projects === 0 && v.collections === 0) {
        ctx.out(chalk.dim("  (empty) the overseer is OPTIONAL infra for reusing a persona across machines/projects,"));
        ctx.out(chalk.dim("  complementing git — not replacing it. Populate with: personaxis personas import <path> · personaxis overseer register <slug>"));
      }
    },
  },
  {
    name: "model",
    desc: "show the model, or set it: /model set <endpoint|model|key-env> <value> [global]",
    run: (arg, ctx) => {
      const parts = arg.trim().split(/\s+/).filter(Boolean);
      if (parts[0] !== "set") {
        ctx.out(chalk.dim(`  model: ${appraiserLabel(ctxModelArg(ctx))}`));
        ctx.out(chalk.dim(`  set (stored in ~/.personaxis, reused everywhere):`));
        ctx.out(chalk.dim(`    /model set endpoint <url> · /model set model <name> · /model set key <API_KEY> · /model set key-env <ENV_VAR>`));
        ctx.out(chalk.dim(`    (append 'project' to write the project config instead of global; per-persona lives in the spec's runtime block)`));
        return;
      }
      const [, key, value, scope] = parts;
      if (!key || !value) return void ctx.out(chalk.yellow("  usage: /model set <endpoint|model|key|key-env> <value> [project]"));
      // Config is GLOBAL by default (reused across projects); pass 'project' to scope it locally.
      const global = scope !== "project";
      const isSecret = key === "key";
      try {
        setModelSetting(key, value, global);
        const shown = isSecret ? value.slice(0, 3) + "…" + value.slice(-2) : value;
        ctx.out(chalk.green(`  ✓ ${key} = ${shown}`) + chalk.dim(` (${global ? "global ~/.personaxis" : "project .personaxis"}/config.json)`));
        if (isSecret) ctx.out(chalk.dim("  key stored user-only (0600), reused across all projects — no env var needed."));
        ctx.out(chalk.dim(`  now: ${appraiserLabel(ctxModelArg(ctx))}`));
      } catch (e) {
        ctx.out(chalk.red(`  ${(e as Error).message}`));
      }
    },
  },
  {
    name: "config",
    desc: "show the resolved model config + where it lives (set with /model set)",
    run: (_a, ctx) => {
      ctx.out(chalk.bold("  Model config") + chalk.dim("  (env > project > global; per-persona via the spec's runtime block)"));
      ctx.out(`  ${chalk.cyan("resolved")}  ${appraiserLabel(ctxModelArg(ctx))}`);
      ctx.out(chalk.dim(`  global   ~/.personaxis/config.json   ·   project   .personaxis/config.json`));
      ctx.out(chalk.dim(`  set from here: /model set <endpoint|model|key|key-env> <value> [project]`));
    },
  },
  {
    name: "hooks",
    desc: "install the end-of-turn learning hook for a host: /hooks <claude-code|codex|openclaw|hermes> [global]",
    run: (arg, ctx) => {
      const [host, scope] = arg.trim().split(/\s+/).filter(Boolean);
      if (!host || !(HOSTS as readonly string[]).includes(host)) {
        return void ctx.out(chalk.yellow(`  usage: /hooks <${HOSTS.join("|")}> [global]`));
      }
      try {
        const r = installHook(host as (typeof HOSTS)[number], scope === "global");
        ctx.out((r.already ? chalk.dim("  · already installed at ") : chalk.green("  ✓ installed at ")) + chalk.cyan(r.path));
        ctx.out(chalk.dim(`  each turn now feeds a governed tick on your model (no host tokens).${r.extra}`));
      } catch (e) {
        ctx.out(chalk.red(`  ${(e as Error).message}`));
      }
    },
  },
  {
    name: "validate",
    desc: "validate this persona's spec against the schema + universals",
    run: (_a, ctx) => {
      const r = validatePersona(loadPersonaFile(ctx.handle.personaPath).data);
      const color = r.status === "PASS" ? chalk.green : r.status.startsWith("PASS") ? chalk.yellow : chalk.red;
      ctx.out(`  ${color(r.status)}` + chalk.dim(` · ${r.errors.length} error(s), ${r.warnings.length} warning(s)`));
      for (const e of [...r.errors, ...r.warnings].slice(0, 8)) ctx.out(chalk.dim(`    · ${e.field}: ${e.message}`));
    },
  },
  {
    name: "lint",
    desc: "lint this persona's spec (tier-aware findings)",
    run: (_a, ctx) => {
      const report = lint(readFileSync(ctx.handle.personaPath, "utf-8"));
      if (report.findings.length === 0) return void ctx.out(chalk.green("  ✓ no lint findings"));
      ctx.out(chalk.bold(`  ${report.summary.errors} error(s) · ${report.summary.warnings} warning(s) · ${report.summary.infos} info`));
      for (const f of report.findings.slice(0, 12)) {
        const c = f.severity === "error" ? chalk.red : f.severity === "warning" ? chalk.yellow : chalk.dim;
        ctx.out(`  ${c(f.severity)} ${chalk.dim(f.rule)} — ${f.message}`);
      }
    },
  },
  {
    name: "init",
    desc: "scaffold a NEW sub-persona under this project: /init <name>",
    run: (arg, ctx) => {
      const name = arg.trim();
      if (!name) return void ctx.out(chalk.yellow("  usage: /init <name>   (creates a sub-persona; the root already exists in this session)"));
      try {
        const path = writeStarterPersona(process.cwd(), name, name);
        const slug = path.split(/[\\/]+/).slice(-2)[0];
        ctx.out(chalk.green("  ✓ created sub-persona ") + chalk.cyan(`@${slug}`) + chalk.dim(` → ${relative(process.cwd(), path).replace(/\\/g, "/")}`));
        ctx.out(chalk.dim(`  next: fill it in, then /compile ${slug} (or address it with @${slug} …)`));
      } catch (e) {
        ctx.out(chalk.red(`  ${(e as Error).message}`));
      }
    },
  },
  {
    name: "serve",
    desc: "start/stop the HTTP server in the background: /serve [port] · /serve stop",
    run: (arg, ctx) => startStopDaemon("serve", arg, ctx, (port) => ["serve", "--persona", ctx.handle.personaPath, "--port", port || "7637"], (port) => `http://localhost:${port || "7637"} (curl /agents.md)`),
  },
  {
    name: "watch",
    desc: "start/stop the freshness daemon in the background: /watch · /watch stop",
    run: (arg, ctx) => startStopDaemon("watch", arg, ctx, () => ["watch", "--persona", ctx.handle.personaPath], () => "recompiling PERSONA.md on spec edits + drift"),
  },
  {
    name: "compact",
    desc: "summarize older turns to free context",
    run: async (_a, ctx) => {
      const llm = llmConfig(ctxModelArg(ctx));
      if (!llm) return void ctx.out(chalk.dim("  /compact needs a model — configure with /model."));
      const r = await compactMessages([{ role: "system", content: "" }, ...ctx.conversation], ctx.meter, { llm, threshold: 0 });
      if (r.compacted) {
        ctx.conversation = r.messages.filter((m) => m.role !== "system");
        // PERSIST the checkpoint so leaving and /resume returns the COMPACTED conversation, not the
        // raw bloat — the user shouldn't have to /compact again after re-entering the same session.
        if (r.summary) {
          ensureCtxSession(ctx, ctx.conversation[0]?.content ?? "session");
          recordCompaction(ctx.handle.personaPath, ctx.sessionId, r.summary);
        }
        ctx.out(chalk.dim(`  compacted ${r.removed} message(s) → ${ctx.conversation.length} kept · persisted (survives /resume)`));
      } else {
        ctx.out(chalk.dim("  nothing to compact yet."));
      }
    },
  },
  {
    name: "sessions",
    desc: "list saved conversations (/resume to continue one)",
    run: (_a, ctx) => {
      const list = listSessions(ctx.handle.personaPath);
      if (!list.length) return void ctx.out(chalk.dim("  no saved sessions yet."));
      ctx.out(chalk.bold(`  Sessions (${list.length})`));
      for (const s of list.slice(0, 12)) {
        const when = s.updated.slice(0, 16).replace("T", " ");
        const live = s.id === ctx.sessionId ? chalk.green(" ● live") : "";
        ctx.out(`  ${chalk.cyan(s.name)}${live} ${chalk.dim(`· ${s.turns} turn(s) · ${when} · ${s.id}`)}`);
      }
    },
  },
  {
    name: "resume",
    desc: "resume a saved conversation: /resume <id|name>",
    run: async (arg, ctx) => {
      const q = arg.trim();
      if (!q) return void ctx.out(chalk.dim("  usage: /resume <id|name> — see /sessions"));
      const s = findSession(ctx.handle.personaPath, q);
      if (!s) return void ctx.out(chalk.yellow(`  no session matching "${q}" — see /sessions`));
      const conv = loadConversation(ctx.handle.personaPath, s.id);
      ctx.conversation = conv;
      ctx.sessionId = s.id;
      ctx.sessionStarted = true;
      ctx.sessionNamed = true;
      ctx.meter.estimate([{ role: "system", content: "" }, ...conv]);
      ctx.out(chalk.green(`  ✓ resumed "${s.name}"`) + chalk.dim(` · ${conv.length} message(s) restored`));
    },
  },
  {
    name: "mode",
    desc: "show/cycle the sandbox posture (shift+tab)",
    run: (_a, ctx) => {
      ctx.postureIndex = (ctx.postureIndex + 1) % POSTURES.length;
      notePostureChange(ctx);
      ctx.out(chalk.dim(`  sandbox posture → ${chalk.bold(POSTURES[ctx.postureIndex])}`));
    },
  },
  {
    name: "goal",
    desc: "set / show / clear a standing goal",
    run: (arg, ctx) => {
      const goalPath = join(dirname(ctx.handle.personaPath), "goal.json");
      if (arg === "clear") {
        if (existsSync(goalPath)) unlinkSync(goalPath);
        return void ctx.out(chalk.dim("  goal cleared."));
      }
      if (arg) {
        writeFileSync(goalPath, JSON.stringify({ text: arg, createdTs: new Date().toISOString() }, null, 2));
        return void ctx.out(chalk.green("  ✓") + ` goal set: ${arg} ${chalk.dim("(used by /do and the loop)")}`);
      }
      const g = readGoalText(ctx.handle);
      ctx.out(g ? `  ${chalk.bold("goal:")} ${g}` : chalk.dim("  no goal set. /goal <text> to set."));
    },
  },
  {
    name: "loop",
    desc: "run n governed Living-Loop ticks",
    run: async (arg, ctx) => {
      const n = Math.max(1, Math.min(20, Number(arg) || 3));
      const goal = readGoalText(ctx.handle) ?? "self-reflection";
      ctx.out(chalk.dim(`  running ${n} governed tick(s) on: ${goal}`));
      for (let i = 1; i <= n; i++) {
        await ctx.loop.tick({ observation: goal, source: "internal", actor: "runtime-context" }).catch((e) => ctx.out(chalk.dim(`  tick ${i} skipped: ${(e as Error).message}`)));
      }
    },
  },
  { name: "exit", desc: "leave the session", run: (_a, ctx) => { stopDaemons(ctx); return true; } },
  { name: "quit", desc: "leave the session", run: () => true },
];

/** The slash-command registry (names + descriptions) — single source of truth. */
export function listCommands(): SlashItem[] {
  return COMMANDS.filter((c) => c.name !== "quit").map((c) => ({ name: c.name, desc: c.desc }));
}

function helpText(): string {
  const lines = [chalk.bold("Commands")];
  for (const c of COMMANDS) {
    if (c.name === "quit") continue;
    lines.push(`  ${chalk.cyan(`/${c.name}`).padEnd(22)} ${chalk.dim(c.desc)}`);
  }
  lines.push("", chalk.dim("Type without a leading / to talk — natural language both converses AND uses tools (one governed agent loop)."));
  return lines.join("\n");
}

/** CLI subcommands handled specially in the REPL (native or background), so the passthrough skips them. */
const REPL_UNAVAILABLE: Record<string, string> = {
  observe: "the living loop already runs a governed tick every turn — feed a one-off with `personaxis observe --observation \"…\"`",
};

export async function runCommand(line: string, ctx: Ctx): Promise<boolean> {
  const name = line.slice(1).split(/\s+/)[0];
  const arg = line.slice(1 + name.length).trim();
  const cmd = COMMANDS.find((c) => c.name === name);
  if (cmd) return (await cmd.run(arg, ctx)) === true;

  // Not a native `/command` — fall through to the CLI so EVERY subcommand is reachable from the app
  // (export, decompile, diff, spec, orchestrate, team, skills, scan, personas, migrate, push/pull, …).
  if (REPL_UNAVAILABLE[name]) {
    ctx.out(chalk.dim(`  /${name}: ${REPL_UNAVAILABLE[name]}.`));
    return false;
  }
  runCliPassthrough(name, arg, ctx);
  return false;
}
