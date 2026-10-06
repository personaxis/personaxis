/**
 * Everything a consumer needs to know about a persona, answered once.
 *
 * M2 gave the turn loop one factory and M3 gave the evolution loop another. Both
 * found the same thing: several callers deriving the same facts from the same file,
 * and one of them deriving one of them differently. This is the layer under both, the
 * facts themselves, and it exists because the drift it found is the worst one yet.
 *
 * ## The bug that made this necessary
 *
 * The SDK's `compiledIdentity()` is documented as "the compiled, LLM-facing identity
 * document", and for a root persona it returned the raw spec body instead. It looked
 * for `PERSONA.md` next to `personaxis.md`, and a root persona's compiled document
 * lives one level ABOVE, beside the `.personaxis/` folder. The file was never there,
 * `existsSync` said no, and the fallback quietly handed back something shorter.
 *
 * Measured on this repository: 2,640 characters returned where the compiled document
 * is 6,283. Not an error, not a warning, just a persona that is less itself everywhere
 * except the REPL, which used a different function that got it right.
 *
 * That is the shape of every finding in this phase. The knowledge existed and was
 * correct; it lived in the CLI, so the SDK could not import it and reinvented it from
 * memory. A fallback then made the reinvention silent.
 *
 * ## Why the answers live in core now
 *
 * A question with two answers has one owner or it has none. `compiledPathFor` was
 * owned by the CLI, which is the one package a library cannot depend on, so the
 * question was effectively unowned for everybody else. It moves here, where the SDK,
 * MCP, the protocol host and the CLI can all reach it, and the CLI re-exports it so
 * nothing that already worked has to change.
 *
 * ## What this does NOT do
 *
 * It does not load a model, run a loop, or touch the network. It reads a file and
 * derives paths, which is why every consumer can afford to call it and why it can be
 * tested without a model. The loops are assembled on top of this, not inside it.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { ensureState, loadPersona, type PersonaHandle } from "../persona.js";

/** The folder a persona's spec lives in. */
const PERSONAXIS_DIR = ".personaxis";

function sameDir(a: string, b: string): boolean {
	const ra = resolve(a);
	const rb = resolve(b);
	return process.platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

/** True if this spec belongs to a sub-persona under `.personaxis/personas/<slug>/`. */
export function isSubagentPath(filePath: string): boolean {
	return filePath.replace(/\\/g, "/").includes(`${PERSONAXIS_DIR}/personas/`);
}

/**
 * Where this persona's compiled document lives.
 *
 *   sub-persona                  -> beside its spec
 *   root persona                 -> one level ABOVE `.personaxis/`, at the project root
 *   root persona in the HOME dir -> beside its spec
 *
 * The home case is a documented assumption rather than a rule the spec states: a home
 * directory is not a project root, so a loose `~/PERSONA.md` would be litter the user
 * never finds and never connects to anything.
 *
 * Single owner. Compile writes here, the REPL reads here, and now so does everybody
 * else, which is the whole point: this used to be two functions and one of them was
 * wrong in the most common layout there is.
 */
export function compiledPathFor(personaPath: string): string {
	const baseDir = dirname(personaPath);
	if (isSubagentPath(personaPath)) return join(baseDir, "PERSONA.md");

	const parent = dirname(baseDir);
	if (sameDir(parent, homedir())) return join(baseDir, "PERSONA.md");

	return join(parent, "PERSONA.md");
}

/** A persona, read, with the paths it implies already resolved. */
export interface AssembledPersona {
	readonly personaPath: string;
	readonly handle: PersonaHandle;
	readonly frontmatter: Record<string, unknown>;
	/** Where the compiled document belongs, whether or not it is there yet. */
	readonly compiledPath: string;
	/**
	 * The compiled document, or `undefined` when it has not been compiled.
	 *
	 * Undefined rather than the spec body, and this is the part that matters. Falling
	 * back silently is what hid the bug this file was written for: a caller that asked
	 * for the compiled identity got something shorter and had no way to tell. A caller
	 * that WANTS the fallback can still write it, in one visible line, and then the
	 * choice is in their code where a reader can see it.
	 */
	readonly compiled: string | undefined;
}

/**
 * Read a persona and answer everything derivable from it.
 *
 * `ensureState` is called here because every caller called it: a persona without a
 * state file is not a persona in a different mode, it is one whose first mutation
 * would fail. Doing it once means nobody has to remember, and nobody can forget.
 */
export function assemble(personaPath: string): AssembledPersona {
	const resolved = resolve(personaPath);
	const handle = loadPersona(resolved);
	ensureState(handle);

	const compiledPath = compiledPathFor(resolved);

	return {
		personaPath: resolved,
		handle,
		frontmatter: handle.frontmatter as Record<string, unknown>,
		compiledPath,
		compiled: existsSync(compiledPath) ? readFileSync(compiledPath, "utf-8") : undefined,
	};
}

/**
 * The identity to put in a system prompt, with the fallback made explicit.
 *
 * The fallback is real and correct: a persona that has never been compiled still has
 * to be able to answer, and its spec body is the best available description of it.
 * What was wrong was doing it silently under a name that promised otherwise, so this
 * is a separate function with the word in it rather than a branch inside the other.
 */
export function identityOf(persona: AssembledPersona): string {
	return persona.compiled ?? persona.handle.body;
}
