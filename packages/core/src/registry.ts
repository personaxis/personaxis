/**
 * Overseer registry + global/overlay persona model (F7).
 *
 * The "master" personaxis-system is a governed *runtime* that is aware of every
 * persona and project in the environment. It is NOT a feeling persona, it
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
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { homedir, hostname, platform, tmpdir, userInfo } from "node:os";
import { join, resolve, dirname } from "node:path";

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
  /**
   * PORTABLE IDENTITY of the project (V8.E4): its git remote, normalised.
   *
   * The path cannot identify a project across machines: the same repository is
   * `C:\Users\me\GitHub\cli` here and `/home/me/src/cli` there, so a path-keyed
   * registry sees two unrelated projects and nothing can pair them. The remote is
   * the same string on every machine that cloned it, which is what lets the fleet
   * say "this is the project you also have on the laptop" and what multi-device
   * sync will key on. Absent for projects that are not git repositories, which then
   * fall back to the canonical path (local-only, and honest about it).
   */
  origin?: string;
  /** How this project got here: opened by hand, or found by a declared-root scan. */
  discovered?: "used" | "scan";
}
/**
 * A Collection is pure ORGANIZATION, a named group of personas/projects, like a
 * folder or tag. No runtime behavior. (Distinct from a Team, below.)
 */
export interface Collection {
  name: string;
  personas: string[];
  projects: string[];
}

/**
 * A Team is an OPERATIONAL multi-agent unit: personas with ROLES, a shared GOAL,
 * that collaborate (e.g. via the blackboard, scoped to the team's members). A team
 * has a lead and members; it is runtime, not just taxonomy.
 */
export interface TeamMember {
  slug: string;
  role: string;
}
export interface Team {
  name: string;
  lead?: string;
  members: TeamMember[];
  goal?: string;
  createdTs: string;
}

export interface Registry {
  version: 1;
  personas: Record<string, PersonaRecord>;
  projects: Record<string, ProjectRecord>;
  collections: Record<string, Collection>;
  teams: Record<string, Team>;
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
  return { version: 1, personas: {}, projects: {}, collections: {}, teams: {}, machines: {} };
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
  // Atomic write: a concurrent reader (another `personaxis` process on the same registry) must never
  // observe a half-written file, otherwise loadRegistry's parse falls back to empty() and silently
  // drops data. Write to a unique temp file, then rename (atomic on the same filesystem).
  const target = registryFile();
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2) + "\n", "utf-8");
  renameSync(tmp, target);
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

/**
 * A path that must NEVER reach the user's registry. One real registry had 26
 * projects, 25 of them throwaway test directories under the OS temp dir (`pxs-onboard-*`),
 * all long deleted, which is why `/overseer` reported "projects 26 · personas 0". A
 * directory under the system temp dir is not somebody's project, in tests or in real use.
 */
export function isEphemeralProjectPath(root: string): boolean {
  const norm = resolve(root).replace(/\\/g, "/").toLowerCase();
  const tmp = resolve(tmpdir()).replace(/\\/g, "/").toLowerCase();
  return norm === tmp || norm.startsWith(`${tmp}/`);
}

/**
 * Register a project the user actually opened. Silently ignores ephemeral paths and
 * paths that do not exist, and stores the CANONICAL path so the same project opened
 * through a different spelling (case, trailing slash, symlink) is one entry, not two.
 */
export function registerProject(
  root: string,
  slugs: string[],
  how: ProjectRecord["discovered"] = "used",
): ProjectRecord | undefined {
  const canonical = resolve(root);
  if (isEphemeralProjectPath(canonical) || !existsSync(canonical)) return undefined;
  const reg = loadRegistry();
  const rec: ProjectRecord = {
    root: canonical,
    slugs,
    lastSeen: new Date().toISOString(),
    machine: machineId(),
    discovered: how,
    ...(gitOrigin(canonical) ? { origin: gitOrigin(canonical) } : {}),
  };
  reg.projects[canonical] = rec;
  touchMachine(reg);
  saveRegistry(reg);
  return rec;
}

/**
 * The project's git remote, normalised so the same repository yields the same string
 * however it was cloned: `git@github.com:me/cli.git`, `https://github.com/me/cli` and
 * `https://github.com/me/cli.git` all become `github.com/me/cli`.
 *
 * Read from `.git/config` directly rather than by shelling out to git: this runs on
 * every command, git may not be installed, and a subprocess per invocation is a cost
 * with no upside.
 */
export function gitOrigin(root: string): string | undefined {
  // A repo can be nested; walk up the way git itself does.
  let dir = resolve(root);
  for (let i = 0; i < 24; i++) {
    const cfg = join(dir, ".git", "config");
    if (existsSync(cfg)) {
      try {
        const text = readFileSync(cfg, "utf-8");
        const block = /\[remote "origin"\]([\s\S]*?)(?:\n\[|$)/.exec(text);
        const url = block ? /^\s*url\s*=\s*(.+)$/m.exec(block[1])?.[1]?.trim() : undefined;
        return url ? normaliseRemote(url) : undefined;
      } catch {
        return undefined;
      }
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

function normaliseRemote(url: string): string {
  return url
    .replace(/^git@([^:]+):/, "$1/")       // git@host:owner/repo → host/owner/repo
    .replace(/^ssh:\/\//, "")
    .replace(/^https?:\/\//, "")
    .replace(/^[^@/]+@/, "")               // strip any user@ prefix
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

export interface RegistryPruneResult {
  removed: string[];
  kept: number;
}

export interface ScanResult {
  /** Projects found and registered on this run. */
  found: ProjectRecord[];
  /** Directories walked, so the caller can say why a scan came back empty. */
  scanned: number;
  /** Roots that do not exist, named rather than skipped in silence. */
  missingRoots: string[];
}

/**
 * Find every project with a persona under the roots the USER declared (V8.E2).
 *
 * The registry only ever knew a project if the REPL had been opened inside it, which is
 * why the fleet showed one project to someone who has ten: nothing ever looked at the
 * disk. This looks, but only where it was told to, and only when asked.
 *
 * Deliberately NOT automatic and NOT the whole home directory: walking someone's disk
 * without being asked is not a feature. `depth` is bounded, and the usual heavy
 * directories are skipped, so a scan over a source folder is quick and predictable.
 */
export function scanForProjects(roots: string[], maxDepth = 4): ScanResult {
  const found: ProjectRecord[] = [];
  const missingRoots: string[] = [];
  let scanned = 0;
  const SKIP = new Set([
    "node_modules", ".git", "dist", "build", "out", "target", "vendor",
    ".next", ".nuxt", ".cache", ".venv", "venv", "__pycache__", ".gradle", ".idea",
  ]);

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    scanned += 1;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return; // unreadable (permissions, a vanished dir): not an error worth stopping for
    }
    // A project is a directory holding `.personaxis/personaxis.md`. Once found, do not
    // descend further: sub-personas live INSIDE it and are discovered by the persona
    // tree, not by the filesystem scan.
    if (existsSync(join(dir, ".personaxis", "personaxis.md"))) {
      const rec = registerProject(dir, subPersonaSlugs(dir), "scan");
      if (rec) found.push(rec);
      return;
    }
    for (const name of entries) {
      if (SKIP.has(name) || name.startsWith(".")) continue;
      walk(join(dir, name), depth + 1);
    }
  };

  for (const root of roots) {
    const abs = resolve(root.replace(/^~(?=[/\\]|$)/, homedir()));
    if (!existsSync(abs)) {
      missingRoots.push(root);
      continue;
    }
    walk(abs, 0);
  }
  return { found, scanned, missingRoots };
}

/** Sub-persona slugs declared inside a project, read from disk. */
function subPersonaSlugs(root: string): string[] {
  const dir = join(root, ".personaxis", "personas");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "personaxis.md")))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Drop registry entries whose directory is gone or that never belonged there
 * (ephemeral paths). Called on read paths that display the registry, and available
 * as `personaxis overseer --prune` for an explicit cleanup.
 */
export function pruneRegistry(): RegistryPruneResult {
  const reg = loadRegistry();
  const removed: string[] = [];
  for (const root of Object.keys(reg.projects)) {
    const gone = isEphemeralProjectPath(root) || !existsSync(root);
    // A folder that still exists but no longer holds ANY persona is not a project of
    // ours either: someone deleted `.personaxis/`. Without this, deleting a persona
    // left a permanent phantom in the fleet, curable only by a manual scan.
    //
    // "Any" is load-bearing: a project may legitimately have sub-personas and no main
    // one, so checking for `personaxis.md` alone would purge a perfectly live project.
    const noPersona = !gone && !hasAnyPersona(root);
    if (gone || noPersona) {
      delete reg.projects[root];
      removed.push(root);
    }
  }
  if (removed.length) saveRegistry(reg);
  return { removed, kept: Object.keys(reg.projects).length };
}

/** Does this folder still hold a persona: a main one, or at least one sub-persona? */
function hasAnyPersona(root: string): boolean {
  if (existsSync(join(root, ".personaxis", "personaxis.md"))) return true;
  const subs = join(root, ".personaxis", "personas");
  if (!existsSync(subs)) return false;
  try {
    return readdirSync(subs, { withFileTypes: true }).some(
      (e) => e.isDirectory() && existsSync(join(subs, e.name, "personaxis.md")),
    );
  } catch {
    return false;
  }
}

/**
 * Forget a project (V8.E5): the other half of registering by use.
 *
 * Called when a persona is deleted, so the registry keeps matching reality without anyone
 * having to run a scan or a cleanup. `pruneRegistry` also drops entries whose directory
 * vanished, but that only helps once the folder is gone: deleting the PERSONA while
 * keeping the folder would otherwise leave a project listed with nothing in it.
 */
export function forgetProject(root: string): boolean {
  const canonical = resolve(root);
  const reg = loadRegistry();
  if (!reg.projects[canonical]) return false;
  delete reg.projects[canonical];
  saveRegistry(reg);
  return true;
}

/** Projects that still exist on this machine, newest first (the display path). */
export function liveProjects(): ProjectRecord[] {
  const reg = loadRegistry();
  return Object.values(reg.projects)
    .filter((p) => existsSync(p.root) && !isEphemeralProjectPath(p.root))
    .sort((a, b) => (b.lastSeen ?? "").localeCompare(a.lastSeen ?? ""));
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

// ─── Teams (operational, with roles + a shared goal) ────────────────────────

export function createTeam(name: string, lead?: string): Team {
  const reg = loadRegistry();
  reg.teams[name] ??= { name, lead, members: lead ? [{ slug: lead, role: "lead" }] : [], createdTs: new Date().toISOString() };
  if (lead) reg.teams[name].lead = lead;
  saveRegistry(reg);
  return reg.teams[name];
}

export function addTeamMember(name: string, slug: string, role: string): Team {
  const reg = loadRegistry();
  const t = (reg.teams[name] ??= { name, members: [], createdTs: new Date().toISOString() });
  const existing = t.members.find((m) => m.slug === slug);
  if (existing) existing.role = role;
  else t.members.push({ slug, role });
  if (role === "lead") t.lead = slug;
  saveRegistry(reg);
  return t;
}

export function setTeamGoal(name: string, goal: string): Team {
  const reg = loadRegistry();
  const t = (reg.teams[name] ??= { name, members: [], createdTs: new Date().toISOString() });
  t.goal = goal;
  saveRegistry(reg);
  return t;
}

export function getTeam(name: string): Team | undefined {
  return loadRegistry().teams[name];
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
  /** V7.A8: personas ACROSS live projects (main + subs), the number a user expects. */
  personasInProjects: number;
  /**
   * The user's own persona at `~/.personaxis/personaxis.md`, if there is one.
   *
   * The home is deliberately NOT a project (it is where the CLI keeps its own
   * config), so it never enters `projects` and its persona was invisible in every
   * count: a user with exactly one persona, their own, saw zeros everywhere.
   */
  homePersona: string | undefined;
  projects: number;
  collections: number;
  teams: number;
  machines: number;
  detail: Registry;
} {
  // V7.A8: self-healing read. Dead and ephemeral entries are dropped before counting,
  // so the view can never again report "projects 26 · personas 0" over deleted temp dirs.
  pruneRegistry();
  const reg = loadRegistry();
  return {
    machine: machineId(),
    // `personas` counts GLOBAL personas (~/.personaxis/personas/<slug>), which is why it
    // read 0 when every persona lives inside a project. That number is now reported too.
    personas: Object.keys(reg.personas).length,
    personasInProjects: Object.values(reg.projects).reduce((n, p) => n + 1 + (p.slugs?.length ?? 0), 0),
    homePersona: existsSync(join(personaxisHome(), "personaxis.md")) ? join(personaxisHome(), "personaxis.md") : undefined,
    projects: Object.keys(reg.projects).length,
    collections: Object.keys(reg.collections).length,
    teams: Object.keys(reg.teams ?? {}).length,
    machines: Object.keys(reg.machines).length,
    detail: reg,
  };
}
