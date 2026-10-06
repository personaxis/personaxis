/**
 * A plugin's code does not run in our process, and one line is all it would take.
 *
 * K4, and the first thing to say is what is already true. A third-party MCP server is
 * spawned as its own process and reached over JSON-RPC, so its code has never run here.
 * The boundary the row asks for exists; what does not exist is anything stopping somebody
 * from stepping over it.
 *
 * ## The one line
 *
 * `await import(userSuppliedPath)`. That is the whole supply-chain hole (ASI04): a
 * plugin's module loaded into this process, with our filesystem, our environment, our
 * network and our credentials, and TYPES DO NOT HELP, because a type is gone before the
 * import happens. It would look like a convenience, it would pass review as one, and no
 * test in this repository would notice.
 *
 * So this sweeps the source for it. Dynamic import of a LITERAL is fine and there are
 * eleven of them: they load our own modules late so the CLI starts fast, and a literal
 * cannot be somebody else's package. What is refused is a specifier that is not a
 * literal, because that is the only form the hole can take.
 *
 * ## What the sweep cannot do, said out loud
 *
 * It reads this repository. A dependency doing the same thing is not visible here, and
 * pretending otherwise would make this look like more protection than it is. That is
 * `K9`'s question, and it is about provenance rather than about our own source.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every source file that ships, which is what an attacker would have to get into. */
function sources(): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir)) {
			if (name === "node_modules" || name === "dist" || name === "generated") continue;
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else if (path.endsWith(".ts") || path.endsWith(".tsx")) found.push(path);
		}
	};
	for (const pkg of readdirSync(PACKAGES)) {
		const src = join(PACKAGES, pkg, "src");
		try {
			if (statSync(src).isDirectory()) walk(src);
		} catch {
			// A package with no `src` is not a finding.
		}
	}
	return found;
}

/**
 * A dynamic import whose specifier is not a literal.
 *
 * Both quote styles and the backtick, because a template literal with no substitution is
 * still a literal and one WITH a substitution is exactly the hole. `require(` is included
 * because `createRequire` exists in this repository and reaches the same place.
 */
const LOADS = /(?:^|[^.\w])(?:import|require)\s*\(\s*([^)]*)\)/g;

const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /^[ \t]*\/\/.*$/gm;

/**
 * A whole specifier that is a literal, with at most a cast after it.
 *
 * Anchored at both ends on purpose. Matching a specifier that merely BEGINS with a quote
 * would let `"./" + name` through, which is the hole spelled with a plus.
 */
const LITERAL_SPECIFIER = /^(?:"[^"]*"|'[^']*'|`[^`$]*`)(?:\s+as\s+\w+)?$/;

/**
 * What comes before a method named `require`, rather than a call to one.
 *
 * `blackboard.ts` has `private require(taskId: string): Task`, and the sweep reported it,
 * which is the third thing it got wrong about this repository before it got it right. A
 * declaration is not a load. Calls through a member are already excluded by the leading
 * character class, so this only has to catch the declaring form.
 */
const DECLARES = /(?:private|public|protected|static|async|function)\s+$/;

/**
 * Comments, gone before anything is matched.
 *
 * The sweep read them first time round and reported `genesis/imports.ts` for a sentence
 * containing the words "import(", which is a finding about the instrument and not about
 * the code. A guard that cries wolf is a guard somebody switches off.
 */
function code(text: string): string {
	return text.replace(BLOCK_COMMENT, " ").replace(LINE_COMMENT, " ");
}

/**
 * Whether a specifier is a literal, allowing the one decoration that is still one.
 *
 * `import("shiki" as string)` is a literal wearing a cast, and the sweep called it an
 * offence first time round. What is NOT allowed is anything that merely STARTS with a
 * quote: `"./" + name` and `path as string` both have to fail, so the whole specifier has
 * to be a literal and at most a cast, rather than beginning with one.
 */
function isLiteral(specifier: string): boolean {
	return LITERAL_SPECIFIER.test(specifier.trim());
}

/** Every load in a file that is a call and not a declaration, as its specifier. */
function loadsIn(text: string): string[] {
	const found: string[] = [];
	for (const match of text.matchAll(LOADS)) {
		const specifier = (match[1] ?? "").trim();
		// An empty specifier is `import.meta` or a type position the regex clipped.
		if (specifier.length === 0) continue;
		if (DECLARES.test(text.slice(Math.max(0, match.index - 20), match.index + 1))) continue;
		found.push(specifier);
	}
	return found;
}

describe("nothing loads code this process did not ship", () => {
	it("has no dynamic import of anything but a literal", () => {
		const offences: string[] = [];

		for (const file of sources()) {
			for (const specifier of loadsIn(code(readFileSync(file, "utf-8")))) {
				if (isLiteral(specifier)) continue;
				offences.push(`${relative(PACKAGES, file)}: import(${specifier.slice(0, 60)})`);
			}
		}

		expect(offences).toEqual([]);
	});

	it("still finds the literal ones, so the sweep is not looking at nothing", () => {
		// A sweep that matched nothing would pass the test above for the wrong reason, and
		// this repository does lazy-load its own modules: eleven at the last count. If this
		// ever reads zero, the regex has stopped working and the guard above is a comment.
		let literals = 0;
		for (const file of sources()) {
			for (const specifier of loadsIn(code(readFileSync(file, "utf-8")))) {
				if (isLiteral(specifier)) literals += 1;
			}
		}

		expect(literals).toBeGreaterThan(5);
	});

	it("would catch the line it exists for", () => {
		// The guard, guarded. If this stops failing, the one above proves nothing.
		const hole = 'const plugin = await import(config.pluginPath);';

		expect(loadsIn(hole).filter((specifier) => !isLiteral(specifier))).toHaveLength(1);
	});

	it("does not object to a template with nothing substituted into it", () => {
		const fine = "await import(`node:fs`);";

		expect(loadsIn(fine).filter((specifier) => !isLiteral(specifier))).toEqual([]);
	});

	it("does not object to a literal wearing a cast, and does object to a name wearing one", () => {
		// Both of these were got wrong first time. The rule is that the WHOLE specifier is
		// a literal, not that it starts with one, or `"./" + name` walks straight through.
		expect(isLiteral('"shiki" as string')).toBe(true);
		expect(isLiteral("config.pluginPath as string")).toBe(false);
		expect(isLiteral('"./" + name')).toBe(false);
	});

	it("does not read prose as code", () => {
		// The other thing it got wrong: a sentence in a comment containing the words it
		// looks for. A guard that cries wolf is a guard somebody switches off.
		const prose = "/** V3.3, the import(embrace-extend) wedge. */";

		expect(loadsIn(code(prose))).toEqual([]);
	});

	it("does not read a method named require as a call to one", () => {
		// The third thing it got wrong. A declaration is not a load, and this repository
		// has one: `private require(taskId: string): Task` in the blackboard.
		const declaration = "	private require(taskId: string): Task {";

		expect(loadsIn(declaration)).toEqual([]);
	});
});
