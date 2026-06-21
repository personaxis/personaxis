/**
 * Overseer registry + global/overlay persona model (F7 — plan/08-persona-model).
 *
 * The "master" personaxis-system is a governed *runtime* that is aware of every
 * persona and project in the environment. It is NOT a feeling persona — it
 * orchestrates and audits. This module is its memory:
 *
 *   ~/.personaxis/ (override with PERSONAXIS_HOME)
 *     registry.json          personas, projects, collections, machines
 *     personas/<slug>/        global identity + memory (reused across projects)
 *
 * Reuse model: a persona lives globally; each project "mounts" it with a local
 * overlay (its own state.json + project memory). So the same persona can be
 * reused WITH accumulated memory, or instantiated fresh per project. Collections
 * (teams) group personas + projects. State is tracked per machine so the same
 * user-clone can live on Windows/Linux/macOS and reconcile via git without one
 * machine clobbering another.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform, userInfo } from "node:os";
import { join } from "node:path";

export interface PersonaRecord {
  slug: string;
  globalPath: string;
  createdTs: string;
}
export interface ProjectRecord {
  root: string;
  slugs: string[];
  lastSeen: string;
  machine: string;
}
export interface Collection {
  name: string;
  personas: string[];
  projects: string[];
}
export interface Registry {
  version: 1;
  personas: Record<string, PersonaRecord>;
  projects: Record<string, ProjectRecord>;
  collections: Record<string, Collection>;
  machines: Record<string, { lastSeen: string; os: string }>;
}

export function personaxisHome(): string {
  return process.env.PERSONAXIS_HOME ?? join(homedir(), ".personaxis");
}

/** A stable per-machine id so cross-OS instances reconcile without clobbering. */
export function machineId(): string {
  return createHash("sha256")
    .update(`${hostname()}|${platform()}|${userInfo().username}`)
    .digest("hex")
    .slice(0, 16);
}

function registryFile(): string {
  return join(personaxisHome(), "registry.json");
}

function empty(): Registry {
  return { version: 1, personas: {}, projects: {}, collections: {}, machines: {} };
}

export function loadRegistry(): Registry {
  const f = registryFile();
  if (!existsSync(f)) return empty();
  try {
    return { ...empty(), ...(JSON.parse(readFileSync(f, "utf-8")) as Registry) };
  } catch {
    return empty();
  }
}

export function saveRegistry(reg: Registry): void {
  mkdirSync(personaxisHome(), { recursive: true });
  writeFileSync(registryFile(), JSON.stringify(reg, null, 2) + "\n", "utf-8");
}

export function globalPersonaDir(slug: string): string {
  return join(personaxisHome(), "personas", slug);
}

export function registerPersona(slug: string): PersonaRecord {
  const reg = loadRegistry();
  const globalPath = join(globalPersonaDir(slug), "personaxis.md");
  if (!reg.personas[slug]) {
    reg.personas[slug] = { slug, globalPath, createdTs: new Date().toISOString() };
  }
  touchMachine(reg);
  saveRegistry(reg);
  return reg.personas[slug];
}

export function registerProject(root: string, slugs: string[]): ProjectRecord {
  const reg = loadRegistry();
  const rec: ProjectRecord = {
    root,
    slugs,
    lastSeen: new Date().toISOString(),
    machine: machineId(),
  };
  reg.projects[root] = rec;
  touchMachine(reg);
  saveRegistry(reg);
  return rec;
}

export function createCollection(name: string): Collection {
  const reg = loadRegistry();
  reg.collections[name] ??= { name, personas: [], projects: [] };
  saveRegistry(reg);
  return reg.collections[name];
}

export function addToCollection(
  name: string,
  kind: "persona" | "project",
  value: string,
): Collection {
  const reg = loadRegistry();
  const c = (reg.collections[name] ??= { name, personas: [], projects: [] });
  const list = kind === "persona" ? c.personas : c.projects;
  if (!list.includes(value)) list.push(value);
  saveRegistry(reg);
  return c;
}

function touchMachine(reg: Registry): void {
  reg.machines[machineId()] = { lastSeen: new Date().toISOString(), os: platform() };
}

/**
 * Resolve the effective persona path for a project + slug: a project-local
 * overlay (project `.personaxis/personas/<slug>/personaxis.md` or root
 * `.personaxis/personaxis.md`) takes precedence over the global persona.
 * Returns the first existing path, or the global path as the default target.
 */
export function resolveEffectivePersona(projectRoot: string, slug?: string): {
  path: string;
  scope: "project-overlay" | "global" | "none";
} {
  const candidates = slug
    ? [
        join(projectRoot, ".personaxis", "personas", slug, "personaxis.md"),
        join(globalPersonaDir(slug), "personaxis.md"),
      ]
    : [join(projectRoot, ".personaxis", "personaxis.md")];
  for (let i = 0; i < candidates.length; i++) {
    if (existsSync(candidates[i])) {
      return { path: candidates[i], scope: i === 0 && slug ? "project-overlay" : "global" };
    }
  }
  return { path: candidates[candidates.length - 1], scope: "none" };
}

/** The overseer's situational summary of the whole environment. */
export function overseerView(): {
  machine: string;
  personas: number;
  projects: number;
  collections: number;
  machines: number;
  detail: Registry;
} {
  const reg = loadRegistry();
  return {
    machine: machineId(),
    personas: Object.keys(reg.personas).length,
    projects: Object.keys(reg.projects).length,
    collections: Object.keys(reg.collections).length,
    machines: Object.keys(reg.machines).length,
    detail: reg,
  };
}
