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
 * So there is one answer, here. Since 2026-10-07 there is also one path: a model writes every
 * compiled document, in session too (the session's hook starts `compile` in the background), and
 * what is here is the input of the reference that document is checked against, and the dressing
 * (sub-persona header, skill list) put in front of it. The faithfulness check now holds the
 * "Memory & resources" lines too, which is what the 2026-09-14 document lost.
 */

import { dirname } from "node:path";

import type { AssembleInput } from "@personaxis/core";

import { isSubagentPath, slugAddressFromPath } from "./load.js";
import { buildResourceManifest } from "./resource-manifest.js";
import { applySkillsToSubagent, type DeclaredSkill, type MaterializedSkill } from "./targets/skills.js";
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

/** The assembler's input for a persona, with the resource manifest a document has to carry. */
export function assembleInputFor(sourcePath: string, data: PersonaDocument, facts: DocumentFacts = {}): AssembleInput {
	const { isSubagent, slug } = placementOf(sourcePath);
	const overlay = facts.appliedOverlay && Object.keys(facts.appliedOverlay).length > 0 ? facts.appliedOverlay : undefined;
	return {
		persona: data,
		resourceManifest: buildResourceManifest(dirname(sourcePath)),
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

