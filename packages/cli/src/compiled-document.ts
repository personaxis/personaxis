/**
 * The compiled document, produced the same way whoever produces it.
 *
 * ## Why this exists
 *
 * Measured on 2026-09-14. A persona's state crossed a band on its first turn in the TUI, and
 * the living loop rewrote its `PERSONA.md` in place, as designed. The rewritten document had
 * lost the header that lists its skills and the resource lines that name its skills and its
 * references. That document is the identity the model reads, so from that turn on the persona
 * no longer saw what it had.
 *
 * Two code paths produced the document. `personaxis compile` handed the assembler the resource
 * manifest, put the sub-persona header in front and applied the skill list. The in-session
 * recompile called the same assembler with none of the three. Each was consistent with itself;
 * they disagreed about what a compiled document is, and nothing compared them.
 *
 * So there is one answer, here, and both paths ask it. What stays with `compile` is what only
 * `compile` can do: polish the text with a model, and copy skills into a host's discovery
 * directory. The in-session recompile writes the deterministic document, which is the canonical
 * one a polish is checked against, and names the skills a compile would copy without copying
 * anything.
 */

import { dirname, join } from "node:path";

import { assemblePersonaDoc, run, type AssembleInput } from "@personaxis/core";

import { isSubagentPath, slugAddressFromPath } from "./load.js";
import { buildResourceManifest } from "./resource-manifest.js";
import { applySkillsToSubagent, resolveDeclaredSkills, type DeclaredSkill, type MaterializedSkill } from "./targets/skills.js";
import type { PlacementPlatform } from "./targets/placement.js";

type PersonaDocument = Record<string, unknown>;

/** The name the compiled document addresses: short_name (chat handle), then display_name, then metadata.name. */
function personaName(data: PersonaDocument): string {
	const identity = (data.identity ?? {}) as { short_name?: string; display_name?: string; canonical_id?: string };
	const meta = (data.metadata ?? {}) as { name?: string };
	return identity.short_name ?? identity.display_name ?? meta.name ?? identity.canonical_id ?? "persona";
}

/**
 * Subagent placement (.claude/agents/<slug>.md, …) expects a `name`/`description` frontmatter the
 * host uses to decide when to invoke the subagent. The deterministic assembler emits the body only,
 * so it is prepended from the spec.
 */
function subagentFrontmatter(slug: string, data: PersonaDocument): string {
	const meta = (data.metadata ?? {}) as { description?: string };
	const identity = (data.identity ?? {}) as { system_identity?: { purpose?: string } };
	const description = (meta.description ?? identity.system_identity?.purpose ?? `The ${slug} persona.`).replace(/\s+/g, " ").trim();
	return `---\nname: ${slug}\ndescription: ${JSON.stringify(description)}\n---\n\n`;
}

/** Where the document stands: a sub-persona carries its address, the root carries none. */
function placementOf(sourcePath: string): { isSubagent: boolean; slug?: string } {
	const slug = slugAddressFromPath(sourcePath);
	return isSubagentPath(sourcePath) && slug ? { isSubagent: true, slug } : { isSubagent: false };
}

/** What changes between two compiles of the same spec: what the persona evolved into, and where its state is. */
interface DocumentFacts {
	/** Applied governed self-edits. An empty set is the same as none. */
	readonly appliedOverlay?: Record<string, unknown>;
	/** Current state values, which select each coordinate's band prose. */
	readonly stateValues?: Record<string, number>;
}

/**
 * The workspace a persona lives in: everything above its `.personaxis` folder.
 *
 * Derived from the persona's own path rather than from `process.cwd()`, because the compiled
 * document is hashed: compiling the same persona from a different directory has to produce the
 * same bytes. A persona outside a `.personaxis` folder has no workspace, so no services.
 */
function workspaceOf(sourcePath: string): string | undefined {
	const parts = sourcePath.replace(/\\/g, "/").split("/");
	const at = parts.lastIndexOf(".personaxis");
	return at < 0 ? undefined : parts.slice(0, at).join("/") || ".";
}

/** The assembler's input for a persona, with what a document has to carry from the disk. */
export function assembleInputFor(sourcePath: string, data: PersonaDocument, facts: DocumentFacts = {}): AssembleInput {
	const { isSubagent, slug } = placementOf(sourcePath);
	const overlay = facts.appliedOverlay && Object.keys(facts.appliedOverlay).length > 0 ? facts.appliedOverlay : undefined;
	// The services this persona leads (E113). Read here, next to the resource manifest, because
	// both are the same kind of fact: what the persona HAS, which lives in the workspace and not
	// in the spec. The assembler itself stays free of the disk.
	const workspace = workspaceOf(sourcePath);
	const services = workspace === undefined ? [] : run.servicesLedBy(workspace, sourcePath);
	return {
		persona: data,
		resourceManifest: buildResourceManifest(dirname(sourcePath)),
		...(services.length === 0 ? {} : { services }),
		target: {
			name: personaName(data),
			isSubagent,
			...(slug === undefined ? {} : { slug }),
			resourceBase: isSubagent ? "./" : "./.personaxis/",
		},
		...(overlay === undefined ? {} : { appliedOverlay: overlay }),
		...(facts.stateValues === undefined ? {} : { stateValues: facts.stateValues }),
	};
}

/** Which skills a compile hands a host, and where it puts them. */
interface SkillPlacement {
	readonly platform: PlacementPlatform;
	readonly declared: DeclaredSkill[];
	readonly materialized: MaterializedSkill[];
}

/**
 * A document body, dressed as a compiled document: a sub-persona gets its header and, when the
 * skills are known, the skill list its host preloads. The root persona's document has neither.
 */
export function dressCompiledDocument(text: string, sourcePath: string, data: PersonaDocument, skills?: SkillPlacement): string {
	const { isSubagent, slug } = placementOf(sourcePath);
	if (!isSubagent || slug === undefined) return text;
	const withHeader = subagentFrontmatter(slug, data) + text;
	return skills === undefined ? withHeader : applySkillsToSubagent(withHeader, skills.platform, [...skills.declared], [...skills.materialized]);
}

/**
 * The skills a compile would copy for a host, named without copying anything.
 *
 * The same selection `materializeLocalSkills` makes, a declared local skill whose `SKILL.md` exists,
 * so the list a live recompile writes is the list the last compile wrote.
 */
function skillsForHost(sourcePath: string, data: PersonaDocument, platform: PlacementPlatform): SkillPlacement {
	const declared = resolveDeclaredSkills(data as Parameters<typeof resolveDeclaredSkills>[0], dirname(sourcePath));
	const root = platform === "claude-code" ? join(".claude", "skills") : join(".agents", "skills");
	const materialized = declared
		.filter((skill) => skill.kind === "local" && !skill.missing && skill.sourceDir !== undefined)
		.map((skill) => ({ name: skill.name, destDir: join(root, skill.name) }));
	return { platform, declared, materialized };
}

/**
 * The document the living loop writes when a band is crossed mid-session.
 *
 * Deterministic, because a turn must not wait on a model to rewrite who it is talking to. The
 * host platform defaults to `claude-code`, which is the convention `compile` uses when no
 * `--platform` is given; a persona compiled for another host gets that host's skill list back
 * at its next `compile`.
 */
export function liveCompiledDocument(
	sourcePath: string,
	data: PersonaDocument,
	facts: DocumentFacts = {},
	platform: PlacementPlatform = "claude-code",
): string {
	const body = assemblePersonaDoc(assembleInputFor(sourcePath, data, facts));
	return dressCompiledDocument(body, sourcePath, data, skillsForHost(sourcePath, data, platform));
}
