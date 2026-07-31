/**
 * Memory view data + actions (V5.P1.4): kind rows over the persona's real memory
 * files, and the cross-OS "open in default editor" helper.
 */

import chalk from "chalk";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import {
  readMemory,
  readSemanticMemory,
  readProcedural,
  readAutobiographical,
  readPreferences,
  readEvaluations,
  readMemoryTypes,
  readMemoryKnobs,
  consolidateSemantic,
  pruneMemory,
} from "@personaxis/core";
import type { Ctx } from "../types.js";
import type { MemoryKindRow } from "./memory.js";

/** Open a file with the platform's default text editor ($VISUAL/$EDITOR first). */
export function openInEditor(path: string): string {
  if (!existsSync(path)) return chalk.dim(`  ${path} does not exist yet.`);
  const editor = process.env.VISUAL || process.env.EDITOR;
  try {
    if (editor) {
      spawn(editor, [path], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
    } else if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", path], { stdio: "ignore", detached: true }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", ["-t", path], { stdio: "ignore", detached: true }).unref();
    } else {
      spawn("xdg-open", [path], { stdio: "ignore", detached: true }).unref();
    }
    return chalk.dim(`  opened ${path}`);
  } catch (e) {
    return chalk.yellow(`  could not open ${path}: ${(e as Error).message}`);
  }
}

const preview = (s: string, n = 88): string => s.replace(/\n+/g, " ").slice(0, n);

export function memoryKindRows(ctx: Ctx): MemoryKindRow[] {
  const p = ctx.handle.personaPath;
  const dir = dirname(p);
  const types = readMemoryTypes(ctx.handle.frontmatter as Record<string, unknown>);
  const on = (k: string): boolean => (types as unknown as Record<string, boolean>)[k] !== false;
  const semantic = readSemanticMemory(p) ?? "";
  const episodic = readMemory(p);
  const procedural = readProcedural(p, 500);
  const auto = readAutobiographical(p, 500);
  const prefs = readPreferences(p);
  const evals = readEvaluations(p, 500);
  return [
    {
      name: "semantic",
      enabled: on("semantic"),
      count: semantic ? semantic.split(/\n/).filter((l) => l.trim()).length : 0,
      file: join(dir, "memory.md"),
      entries: () => (semantic ? semantic.split(/\n/).filter((l) => l.trim()).map((l) => preview(l)) : []),
    },
    {
      name: "episodic",
      enabled: on("episodic"),
      count: episodic.length,
      file: join(dir, "memory", "episodic.jsonl"),
      entries: () => episodic.slice(-200).map((e) => `${chalk.dim(e.ts?.slice(0, 16) ?? "")} ${preview(e.content)}`),
    },
    {
      name: "procedural",
      enabled: on("procedural"),
      count: procedural.length,
      file: join(dir, "memory", "procedural.jsonl"),
      entries: () => procedural.map((e) => preview(JSON.stringify(e))),
    },
    {
      name: "autobiographical",
      enabled: on("autobiographical"),
      count: auto.length,
      file: join(dir, "memory", "autobiographical.jsonl"),
      entries: () => auto.map((e) => preview(JSON.stringify(e))),
    },
    {
      name: "preferences",
      enabled: on("preferences"),
      count: Object.keys(prefs ?? {}).length,
      file: join(dir, "memory", "preferences.jsonl"),
      entries: () => Object.entries(prefs ?? {}).map(([k, v]) => `${chalk.cyan(k)} ${preview(JSON.stringify(v))}`),
    },
    {
      name: "evaluations",
      enabled: on("evaluations"),
      count: evals.length,
      file: join(dir, "memory", "evaluations.jsonl"),
      entries: () => evals.map((e) => `${chalk.dim(e.target)} ${e.dimension} ${e.score.toFixed(2)} ${preview(e.rationale ?? "", 60)}`),
    },
  ];
}

export function memoryConsolidate(ctx: Ctx): string {
  const c = consolidateSemantic(ctx.handle.personaPath);
  return chalk.green("  ✓ ") + `memory.md consolidated (${c.count} entries kept by salience)`;
}

export function memoryPrune(ctx: Ctx): string {
  const days = readMemoryKnobs(ctx.handle.frontmatter as Record<string, unknown>).retentionDays;
  if (!days) return chalk.dim("  no retention window declared (runtime.memory.retention_days_default); nothing to prune.");
  const r = pruneMemory(ctx.handle.personaPath, days);
  return chalk.green("  ✓ ") + `${r.pruned} entr${r.pruned === 1 ? "y" : "ies"} beyond ${days}d tombstoned.`;
}
