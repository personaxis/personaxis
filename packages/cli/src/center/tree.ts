/**
 * The scope tree (V9 / G.1): the Command Center as a NAVIGABLE TREE, not eight sibling screens.
 *
 * Every level of management, machine → project → persona → layer → field, is a `ScopeNode` with
 * the same shape: attributes it reads, actions it offers, and children below it. A console like
 * AWS or k9s works this way for a reason: adding something manageable is a new node, never a new
 * bespoke screen, and "where am I / what does this act on / what does Enter do" is answerable at
 * every depth from the node itself.
 *
 * This module is PURE of Ink: it produces data. The navigator (G.4) renders any node the same
 * way, and the external gate (G.5, `personaxis console`) serializes the very same tree, so the
 * TUI and an agent see one model. Data comes from the engine primitives already in core
 * (`loadRegistry`, `livePresence`, `extractEnvelopes`, …) and from `repl/scope.ts` (effective
 * config); nothing here reimplements them.
 *
 * Children are LAZY (`children()` is a function), so opening the machine node does not walk every
 * persona on disk; each level is computed when it is entered.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { hostname } from "node:os";
import {
  loadRegistry,
  livePresence,
  describePresence,
  extractEnvelopes,
  displayName,
  readState,
  proposals,
  readMode,
  type PersonaFrontmatter,
} from "@personaxis/core";
import { hostsFor } from "../repl/scope.js";
import { loadPersonaFile } from "../load.js";
import { numericFieldEffect, qualitativeEffect, CANONICAL_LAYERS } from "./authority.js";

export type ScopeLevel =
  | "machine"
  | "global"
  | "activity"
  | "project"
  | "persona"
  | "identity"
  | "layers"
  | "layer"
  | "field"
  | "state"
  | "drift"
  | "evolution"
  | "permissions"
  | "model";

/** One readable attribute of a node (value + where it came from). */
export interface Attr {
  key: string;
  value: string;
  note?: string;
}

/**
 * Something you can DO to a node. `effect` is resolved against governance/permissions in G.3;
 * `navigate` just drills in. Until G.3 fills authority, an edit whose target is protected is
 * already `blocked` (protection is a fact of the spec, not a permission question).
 */
export interface Action {
  id: string;
  label: string;
  kind: "navigate" | "edit" | "run" | "toggle";
  effect: "navigate" | "direct" | "proposal" | "blocked";
  authority?: string;
}

export interface LiveStatus {
  instances: number;
  summary: string;
}

export interface ScopeNode {
  level: ScopeLevel;
  /** Stable id, the path segment used by the external gate (`console get machine/<proj>/…`). */
  id: string;
  title: string;
  /** Breadcrumb ids from the root to this node. */
  path: string[];
  attributes: Attr[];
  actions: Action[];
  children: () => ScopeNode[];
  live?: LiveStatus;
  /**
   * Filesystem path of the persona this node edits, when it is editable (a field). The host uses
   * it to route an edit to the right persona (main or a sub) via the SDK. Not part of the
   * external `console` serialization (which is by id-path); it is a runtime execution hint.
   */
  personaPath?: string;
}

const NAV: Action = { id: "open", label: "open", kind: "navigate", effect: "navigate" };

/** Read a persona's frontmatter, tolerating a missing/broken file (returns null). */
function readFm(personaPath: string): PersonaFrontmatter | null {
  try {
    return loadPersonaFile(personaPath).data as PersonaFrontmatter;
  } catch {
    return null;
  }
}

/** Sub-personas of a main persona, discovered from `.personaxis/personas/<slug>/…`, recursive. */
function subPersonaPaths(mainPath: string): Array<{ address: string; personaPath: string }> {
  const out: Array<{ address: string; personaPath: string }> = [];
  const walk = (dir: string, prefix: string): void => {
    const personasDir = join(dir, "personas");
    if (!existsSync(personasDir)) return;
    let slugs: string[] = [];
    try {
      slugs = readdirSync(personasDir).filter((s) => {
        try {
          return statSync(join(personasDir, s)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      return;
    }
    for (const slug of slugs) {
      const p = join(personasDir, slug, "personaxis.md");
      const address = prefix ? `${prefix}/${slug}` : slug;
      if (existsSync(p)) out.push({ address, personaPath: p });
      walk(join(personasDir, slug), address); // nested subs
    }
  };
  walk(dirname(mainPath), "");
  return out;
}

/** Every layer key an envelope coordinate belongs to (its first dotpath segment). */
function envelopesByLayer(fm: PersonaFrontmatter): Map<string, Array<{ key: string; env: ReturnType<typeof extractEnvelopes>["envelopes"][string] }>> {
  const { envelopes } = extractEnvelopes(fm);
  const byLayer = new Map<string, Array<{ key: string; env: (typeof envelopes)[string] }>>();
  for (const [key, env] of Object.entries(envelopes)) {
    const layer = key.split(".")[0]!;
    if (!byLayer.has(layer)) byLayer.set(layer, []);
    byLayer.get(layer)!.push({ key, env });
  }
  return byLayer;
}

// ── Field / Layer / Persona-facet builders ──────────────────────────────────

function fieldNode(personaPath: string, parentPath: string[], key: string, env: ReturnType<typeof extractEnvelopes>["envelopes"][string], protectedKeys: string[], stateValues: Record<string, number>): ScopeNode {
  const current = typeof stateValues[key] === "number" ? stateValues[key] : env.mean;
  // G.3: authority resolved by the shared module (protected → blocked, else clamped direct).
  const auth = numericFieldEffect(key, protectedKeys);
  return {
    level: "field",
    id: key,
    title: key,
    path: [...parentPath, key],
    personaPath, // so the host can route the edit to this persona (main or sub)
    attributes: [
      { key: "current", value: current.toFixed(2), note: `mean ${env.mean.toFixed(2)}` },
      { key: "range", value: `${env.min.toFixed(2)} … ${env.max.toFixed(2)}` },
      ...(env.halfLife != null ? [{ key: "half_life", value: `${env.halfLife} turns` }] : []),
    ],
    actions: [{ id: "edit", label: "edit value", kind: "edit", effect: auth.effect, authority: auth.reason }],
    children: () => [],
  };
}

function layerNode(personaPath: string, parentPath: string[], layer: string, coords: Array<{ key: string; env: ReturnType<typeof extractEnvelopes>["envelopes"][string] }>, protectedKeys: string[], stateValues: Record<string, number>): ScopeNode {
  const path = [...parentPath, layer];
  return {
    level: "layer",
    id: layer,
    title: layer,
    path,
    attributes: [{ key: "coordinates", value: String(coords.length) }],
    actions: [NAV],
    children: () => coords.map((c) => fieldNode(personaPath, path, c.key, c.env, protectedKeys, stateValues)),
  };
}

function layersNode(personaPath: string, parentPath: string[], fm: PersonaFrontmatter): ScopeNode {
  const path = [...parentPath, "layers"];
  const byLayer = envelopesByLayer(fm);
  const { protectedFields } = extractEnvelopes(fm);
  const protectedKeys = protectedFields ?? [];
  const state = readStateValues(personaPath);
  return {
    level: "layers",
    id: "layers",
    title: "Layers",
    path,
    attributes: [{ key: "layers with coordinates", value: String(byLayer.size) }],
    actions: [NAV],
    children: () =>
      [...byLayer.entries()].map(([layer, coords]) => layerNode(personaPath, path, layer, coords, protectedKeys, state)),
  };
}

/** Current numeric state values keyed by envelope dotpath, {} if none. */
function readStateValues(personaPath: string): Record<string, number> {
  try {
    const statePath = join(dirname(personaPath), "state.json");
    const st = readState(statePath) as { values?: Record<string, number> } | null;
    return st?.values ?? {};
  } catch {
    return {};
  }
}

function personaNode(personaPath: string, address: string, parentPath: string[]): ScopeNode {
  const fm = readFm(personaPath);
  const name = fm ? displayName(fm) : basename(dirname(personaPath));
  const label = address === "" ? "main" : `@${address}`;
  const id = address === "" ? "main" : address;
  const path = [...parentPath, id];
  const instances = livePresence(personaPath);
  const subs = subPersonaPaths(personaPath);

  return {
    level: "persona",
    id,
    title: `${name} (${label})`,
    path,
    attributes: [
      { key: "name", value: name },
      { key: "spec_version", value: fm ? String((fm as { spec_version?: unknown }).spec_version ?? "?") : "(unreadable)" },
      { key: "compiled into", value: hostsFor(personaPath).join(", ") || "not compiled" },
      { key: "sub-personas", value: String(subs.length) },
    ],
    live: { instances: instances.length, summary: instances.length ? describePresence(instances) : "idle" },
    actions: [NAV],
    children: () => {
      const facets: ScopeNode[] = [];
      if (fm) facets.push(layersNode(personaPath, path, fm));
      if (fm) facets.push(permissionsNode(personaPath, path, fm));
      facets.push(evolutionNode(personaPath, path));
      // Recurse into sub-personas: a sub is just another persona node.
      for (const s of subs) facets.push(personaNode(s.personaPath, s.address, path));
      return facets;
    },
  };
}

/**
 * The Permissions facet (G.3, R4): for each canonical layer, whether an edit applies directly,
 * queues as a proposal, or is blocked, under this persona's governance. Resolved by the engine's
 * `editGate` via `qualitativeEffect`, so it is the truth the loop would enforce, not a guess.
 */
function permissionsNode(personaPath: string, parentPath: string[], fm: PersonaFrontmatter): ScopeNode {
  const mode = readMode(fm, personaPath);
  const path = [...parentPath, "permissions"];
  return {
    level: "permissions",
    id: "permissions",
    title: "Permissions",
    path,
    attributes: [{ key: "improve mode", value: mode, note: "governs how edits are handled" }],
    actions: [NAV],
    children: () =>
      CANONICAL_LAYERS.map((layer) => {
        const auth = qualitativeEffect(layer, fm, mode);
        return {
          level: "permissions" as const,
          id: layer,
          title: layer,
          path: [...path, layer],
          attributes: [{ key: "edit", value: auth.effect, note: auth.reason }],
          actions: [{ id: "edit", label: `edit ${layer}`, kind: "edit" as const, effect: auth.effect, authority: auth.reason }],
          children: () => [],
        };
      }),
  };
}

function evolutionNode(personaPath: string, parentPath: string[]): ScopeNode {
  const pending = (() => {
    try {
      return proposals(personaPath).filter((p) => p.status === "pending").length;
    } catch {
      return 0;
    }
  })();
  return {
    level: "evolution",
    id: "evolution",
    title: "Evolution",
    path: [...parentPath, "evolution"],
    attributes: [{ key: "pending proposals", value: String(pending) }],
    actions: [NAV],
    children: () => [],
  };
}

// ── Project / Machine builders ───────────────────────────────────────────────

function projectNode(root: string, slugs: string[], parentPath: string[]): ScopeNode {
  const id = basename(root);
  const path = [...parentPath, id];
  const mainPath = join(root, ".personaxis", "personaxis.md");
  return {
    level: "project",
    id,
    title: id,
    path,
    attributes: [
      { key: "root", value: root },
      { key: "personas", value: String(1 + slugs.length), note: `main + ${slugs.length} sub(s)` },
    ],
    actions: [NAV],
    children: () => (existsSync(mainPath) ? [personaNode(mainPath, "", path)] : []),
  };
}

/** Machine-wide live activity: every running instance across every registered persona. */
function activityNode(parentPath: string[]): ScopeNode {
  const reg = loadRegistry();
  const instances: string[] = [];
  for (const root of Object.keys(reg.projects ?? {})) {
    const mainPath = join(root, ".personaxis", "personaxis.md");
    if (!existsSync(mainPath)) continue;
    for (const p of livePresence(mainPath)) {
      instances.push(`${basename(root)}/main · ${p.host} (${p.activity ?? "idle"})`);
    }
  }
  return {
    level: "activity",
    id: "activity",
    title: "Live activity",
    path: [...parentPath, "activity"],
    attributes: instances.length
      ? instances.map((line, i) => ({ key: `instance ${i + 1}`, value: line }))
      : [{ key: "instances", value: "none live right now" }],
    actions: [NAV],
    children: () => [],
  };
}

/** The root of the tree: this machine. */
export function machineNode(): ScopeNode {
  const reg = loadRegistry();
  const roots = Object.keys(reg.projects ?? {});
  const path = ["machine"];
  return {
    level: "machine",
    id: "machine",
    title: hostname(),
    path,
    attributes: [
      { key: "host", value: hostname() },
      { key: "projects", value: String(roots.length) },
    ],
    actions: [NAV],
    children: () => [
      activityNode(path),
      ...roots
        .filter((root) => existsSync(join(root, ".personaxis", "personaxis.md")))
        .map((root) => projectNode(root, reg.projects[root]?.slugs ?? [], path)),
    ],
  };
}

/**
 * The subtree for a single persona, without going through the machine/registry. Used by the
 * project-scoped Command Center (which already knows its persona) and by tests.
 */
export function personaTree(personaPath: string, address = "", parentPath: string[] = ["machine"]): ScopeNode {
  return personaNode(personaPath, address, parentPath);
}

/** Walk a tree from `root` by an id-path (which must start with `root.path`). */
export function walkFrom(root: ScopeNode, pathSegments: string[]): ScopeNode | null {
  if (pathSegments.length < root.path.length) return null;
  let node: ScopeNode = root;
  for (const seg of pathSegments.slice(root.path.length)) {
    const next = node.children().find((c) => c.id === seg);
    if (!next) return null;
    node = next;
  }
  return node;
}

/** Resolve a node by its `console`-style path (`machine/<proj>/main/layers/personality/…`). */
export function nodeAt(pathSegments: string[]): ScopeNode | null {
  if (pathSegments.length === 0 || pathSegments[0] !== "machine") return null;
  return walkFrom(machineNode(), pathSegments);
}
