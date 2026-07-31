/**
 * PERSONA SCOPES: the one contract every miniapp uses to answer "which persona am I
 * looking at, and where does this value come from?".
 *
 * Most commands used to operate on the main persona only, which made sub-personas
 * effectively unmanageable. The fix is NOT a selector bolted onto each command; it is this
 * module. A view asks for `personaScopes(ctx)`, keeps an index into it, and reads every
 * value through `settingFor`, so the main persona and every sub are reachable through the
 * same code path and nothing is implicitly "the main one".
 *
 * A setting can be configured globally, per project, per persona, or in the persona's own
 * spec, so every resolved value carries its ORIGIN: which layer set it, and whether this
 * persona declared it or inherited it. Nothing implicit.
 *
 * The hierarchy:
 *   improve   PER PERSONA   it lives in each persona's own personaxis.md
 *   sandbox   PER SESSION   one posture per terminal, applied to everything run there
 *
 * Reads are cached by path+mtime: a project with many sub-personas must not re-parse every
 * spec on each of the four redraws per second the animated views ask for.
 */

import { statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  resolveModel,
  readMode,
  listTargets,
  placeForTarget,
  isSoulTarget,
  readMemoryTypes,
  globalConfigPath,
  projectConfigPath,
  slugFromPersonaPath,
  type ModelConfigFile,
} from "@personaxis/core";
import { readFileSync, existsSync } from "node:fs";
import { loadPersonaFile, slugAddressFromPath, getPersonaDisplayName, compiledPathFor } from "../load.js";
import { discoverTree } from "./roster.js";
import { POSTURES } from "./config.js";
import type { Ctx } from "./types.js";

/** One addressable persona: the main one, or a sub at any depth. */
export interface PersonaScope {
  /** Hierarchical address from the main persona; "" for the main persona itself. */
  address: string;
  /** How it is written in the UI and in `@` addressing: "main" or "cmo/legal". */
  label: string;
  /** Absolute path to this persona's personaxis.md. */
  personaPath: string;
  /** Display name from its identity layer. */
  name: string;
  /** Nesting depth (0 = main). */
  depth: number;
}

/** Where an effective value came from, lowest precedence first. */
export type SettingOrigin =
  | "default"
  | "global"
  | "project"
  | "assigned"
  | "spec"
  | "policy"
  | "env"
  | "session";

export interface EffectiveSetting {
  /** Human-readable effective value. */
  value: string;
  /** The layer that decided it. */
  origin: SettingOrigin;
  /**
   * True when THIS persona (its own spec or its own per-persona assignment) set the value,
   * false when it inherited it from a wider scope. Making that distinction visible is the
   * point: the effective value AND where it came from, owned versus inherited.
   */
  own: boolean;
  /** Present when the value cannot be edited here, saying why. */
  readonly?: string;
}

/** The settings the matrix covers. */
export const MATRIX_SETTINGS = ["model", "improve", "sandbox", "memory", "hooks"] as const;
export type MatrixSetting = (typeof MATRIX_SETTINGS)[number];

// ── spec cache ───────────────────────────────────────────────────────────────
// Keyed by path, invalidated by mtime, so an edit is picked up on the next read but a
// project with twenty sub-personas is not re-parsed on every animation frame.
interface CachedSpec {
  mtimeMs: number;
  frontmatter: Record<string, unknown>;
  name: string;
}
const specCache = new Map<string, CachedSpec>();

function readSpec(personaPath: string): CachedSpec | undefined {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(personaPath).mtimeMs;
  } catch {
    return undefined;
  }
  const hit = specCache.get(personaPath);
  if (hit && hit.mtimeMs === mtimeMs) return hit;
  try {
    const loaded = loadPersonaFile(personaPath);
    const entry: CachedSpec = {
      // `loaded.data` IS the parsed frontmatter, not a wrapper around it. Reading
      // `loaded.data.frontmatter` yielded undefined, which the `?? {}` downstream turned
      // into "this persona declares nothing" — every setting silently reported its
      // default. Silent defaults are the worst failure mode for a view whose entire job
      // is to say where a value came from, so the type assertion is explicit here.
      mtimeMs,
      frontmatter: loaded.data as unknown as Record<string, unknown>,
      name: getPersonaDisplayName(loaded.data),
    };
    specCache.set(personaPath, entry);
    return entry;
  } catch {
    // A persona that cannot be parsed is reported as unreadable by the caller rather than
    // crashing the whole view; the matrix still lists it, with its defaults.
    return undefined;
  }
}

/** Drop cached specs; call after a write so the next read sees it even within one mtime tick. */
export function invalidateScopeCache(personaPath?: string): void {
  if (personaPath) specCache.delete(personaPath);
  else specCache.clear();
}

/**
 * Every persona reachable from this session: the main one first, then the whole sub tree
 * depth-first. The main persona is the ROOT of the tree the session was opened on, so
 * opening the REPL on a sub still lists that sub's own children.
 */
export function personaScopes(ctx: Ctx): PersonaScope[] {
  const root = ctx.handle.personaPath;
  const rootAddress = slugAddressFromPath(root);
  const rootSpec = readSpec(root);
  const scopes: PersonaScope[] = [
    {
      address: "",
      label: rootAddress ? `@${rootAddress}` : "main",
      personaPath: root,
      name: rootSpec?.name ?? ctx.name,
      depth: 0,
    },
  ];
  for (const ref of discoverTree(root)) {
    scopes.push({
      address: ref.address,
      label: ref.address,
      personaPath: ref.path,
      name: readSpec(ref.path)?.name ?? ref.slug,
      depth: ref.depth,
    });
  }
  return scopes;
}

/** Find a scope by its address ("" = main); falls back to main when the address is gone. */
export function scopeByAddress(scopes: PersonaScope[], address: string): PersonaScope {
  return scopes.find((s) => s.address === address) ?? scopes[0];
}

/**
 * The session context as seen FROM another persona: same session (posture, theme, meter,
 * usage), different persona files. This is what lets one view render main or any sub
 * without every collector growing a persona argument, and it is READ-ONLY by construction:
 * the loop, responder and conversation still belong to the persona you are talking to, so
 * a scoped view can display another persona but can never make it speak or evolve by
 * accident. The goal is managing all personas from one place, not letting the
 * session to silently jump between them.
 */
export function scopedCtx(ctx: Ctx, scope: PersonaScope): Ctx {
  if (scope.personaPath === ctx.handle.personaPath) return ctx;
  const spec = readSpec(scope.personaPath);
  if (!spec) return ctx;
  return {
    ...ctx,
    name: scope.name,
    handle: {
      ...ctx.handle,
      personaPath: scope.personaPath,
      statePath: join(dirname(scope.personaPath), "state.json"),
      frontmatter: spec.frontmatter as typeof ctx.handle.frontmatter,
      body: "",
    },
  };
}

function readConfigFile(path: string): ModelConfigFile {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ModelConfigFile;
  } catch {
    return {};
  }
}

/**
 * Which layer decided this persona's model. `resolveModel` merges the layers and returns
 * only the winner, so the origin is recomputed here by walking the same layers in the same
 * order. Kept adjacent to that function's documented precedence; if it ever changes, this
 * walk must change with it (there is a test pinning the two together).
 */
function modelOrigin(personaPath: string, frontmatter: Record<string, unknown>): { origin: SettingOrigin; own: boolean } {
  if (process.env.PERSONAXIS_ENDPOINT || process.env.PERSONAXIS_MODEL) return { origin: "env", own: false };
  const runtime = frontmatter.runtime as { model?: string; endpoint?: string } | undefined;
  if (runtime?.model || runtime?.endpoint) return { origin: "spec", own: true };
  const slug = slugFromPersonaPath(personaPath);
  const project = readConfigFile(projectConfigPath());
  const global = readConfigFile(globalConfigPath());
  if (slug && (project.personas?.[slug] || global.personas?.[slug])) return { origin: "assigned", own: true };
  if (project.defaultProfile || project.local) return { origin: "project", own: false };
  if (global.defaultProfile || global.local) return { origin: "global", own: false };
  return { origin: "default", own: false };
}

/**
 * Which hosts can actually READ this persona right now (V7.C5).
 *
 * A persona can be live in several places at once, compiled into different host agents.
 * Presence ("is it awake") and reach ("which agents can read it") are different questions;
 * this answers the second, for every host the compiler supports.
 *
 * The host list is NOT duplicated here. It is derived from the compile-target registry in
 * `@personaxis/core`, and each host's file location comes from that target's own `place()`
 * — the same function `compile` uses to write it. A hand-kept second list is how this
 * function first shipped claiming only two hosts existed while the compiler had supported
 * four (claude-code, codex, openclaw, hermes) all along; deriving it means registering a
 * new target is enough for it to appear here too.
 *
 * Reach is verified against the filesystem, never inferred from configuration:
 *
 *   SOUL hosts (openclaw, hermes)  the placed SOUL.md IS the identity, so its existence
 *                                  is the whole proof.
 *   baseline hosts (claude-code,   a sub-persona has its own placed file; the MAIN persona
 *   codex)                         is reached indirectly, through a baseline (CLAUDE.md /
 *                                  AGENTS.md) that references the compiled document. The
 *                                  compiled document existing is not enough, and neither
 *                                  is a baseline that happens to exist for other reasons:
 *                                  the managed block must be in it.
 */

/** The marker `personaxis compile` writes around the block it manages in a baseline file. */
const BASELINE_MARKER = "<!-- PERSONA:BASELINE:BEGIN -->";

/** Baseline file each non-SOUL host reads at the project root. */
const BASELINE_FILE: Record<string, string> = {
  "claude-code": "CLAUDE.md",
  codex: "AGENTS.md",
};

export function hostsFor(personaPath: string): string[] {
  const root = projectRootOf(personaPath);
  const address = slugAddressFromPath(personaPath);
  const isSubagent = address !== "";
  const slug = isSubagent ? address.split("/").pop()! : undefined;
  const rootOutputPath = basename(compiledPathFor(personaPath));

  const reached: string[] = [];
  for (const id of listTargets()) {
    let placed: string;
    try {
      placed = placeForTarget("", id, { isSubagent, slug, rootOutputPath }).path;
    } catch {
      continue; // a target that cannot place is not a target this persona reaches
    }
    if (!existsSync(join(root, ...placed.split("/")))) continue;
    // A baseline host reading the MAIN persona also needs the baseline to point at it.
    if (!isSoulTarget(id) && !isSubagent) {
      const baseline = BASELINE_FILE[id];
      if (!baseline) continue;
      try {
        if (!readFileSync(join(root, baseline), "utf-8").includes(BASELINE_MARKER)) continue;
      } catch {
        continue;
      }
    }
    reached.push(id);
  }
  return reached;
}

/**
 * The effective value of one setting for one persona, with its origin.
 *
 * `sandbox` is a property of the SESSION, so it reads the same for every persona and is
 * marked read-only per persona: pretending it were per-persona would be a lie the UI told
 * about its own model.
 */
export function settingFor(ctx: Ctx, scope: PersonaScope, setting: MatrixSetting): EffectiveSetting {
  const spec = readSpec(scope.personaPath);
  const fm = spec?.frontmatter ?? {};

  switch (setting) {
    case "model": {
      const resolved = resolveModel({ personaPath: scope.personaPath, frontmatter: fm });
      const { origin, own } = modelOrigin(scope.personaPath, fm);
      return { value: resolved ? resolved.model : "offline (heuristic)", origin: resolved ? origin : "default", own: resolved ? own : false };
    }
    case "improve": {
      // improve is PER PERSONA. The EFFECTIVE mode is what `readMode`
      // returns, and that is deliberately not just the spec's field: a sibling policy.yaml
      // can cap it, and the more restrictive of the two wins. Reading the frontmatter
      // directly here would let the matrix display "autonomous" for a persona the runtime
      // actually holds at "locked", which is the precise class of lie this view exists to
      // remove. The origin says which of the two decided it.
      const declared = (fm.improvement_policy as { mode?: string } | undefined)?.mode;
      const effective = readMode(fm, scope.personaPath);
      if (!declared) {
        return effective === "locked"
          ? { value: effective, origin: "default", own: false }
          : { value: effective, origin: "policy", own: false };
      }
      return declared === effective
        ? { value: effective, origin: "spec", own: true }
        : {
            value: effective,
            origin: "policy",
            own: false,
            readonly: `its personaxis.md asks for "${declared}", but policy.yaml caps it at "${effective}"; the stricter of the two always wins`,
          };
    }
    case "sandbox":
      return {
        value: POSTURES[ctx.postureIndex],
        origin: "session",
        own: false,
        readonly: "the sandbox posture is per SESSION (one per terminal), not per persona: shift+tab changes it for everything running here",
      };
    case "memory": {
      const types = readMemoryTypes(fm);
      const on = (Object.entries(types) as [string, boolean][]).filter(([, v]) => v).map(([k]) => k);
      return { value: on.length ? on.join(", ") : "(none)", origin: "spec", own: true };
    }
    case "hooks": {
      const installed = hostsFor(scope.personaPath);
      return {
        value: installed.length ? installed.join(", ") : "(not compiled into any host)",
        origin: "project",
        own: false,
      };
    }
  }
}

/** The project directory holding `.personaxis/`, walking up from a persona path. */
export function projectRootOf(personaPath: string): string {
  let dir = dirname(personaPath);
  // …/.personaxis/personas/<slug>[/personas/<slug>…]/personaxis.md → up to the project.
  while (dir && basename(dir) !== ".personaxis") {
    const parent = dirname(dir);
    if (parent === dir) return dirname(personaPath);
    dir = parent;
  }
  return dirname(dir);
}
