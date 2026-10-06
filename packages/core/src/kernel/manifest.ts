/**
 * What a plugin says it contributes, before any of it has run.
 *
 * K1. The kernel can already mount a component, resolve what it needs and undo exactly
 * what it did. What it cannot do is answer "what is in this plugin" without ACTIVATING
 * it, because a `Component` is a function and its contributions only exist once the
 * function has been called. For the six built-ins that is fine: we wrote them. For
 * anything a person installs it is the whole problem, and it is three problems wearing
 * one coat.
 *
 * **Security.** A tool's description is injected into the prompt. So a plugin that has
 * to run in order to be listed has already run before anybody could decide whether to
 * trust it, and a malicious one does not need its `execute` to ever be called: the
 * injection happens at the moment its description reaches the model. Reading the
 * catalogue and running the code have to be separable, and the manifest is what
 * separates them.
 *
 * **Startup.** Activating everything to find out what exists is a cost paid on every
 * start, by every persona, for plugins that will mostly not be used in that session.
 * K2 makes activation lazy, and lazy is only possible once there is something to read
 * that is not the code.
 *
 * **Introspection.** "What does this persona have" is a question a person asks, a
 * screen renders and a policy is written against. Answering it by running things means
 * the answer has side effects.
 *
 * ## A manifest is DATA, and that is enforced rather than requested
 *
 * The property that makes the security argument true is not that a manifest ought to be
 * plain: it is that anything else is refused. `readManifest` walks the property
 * DESCRIPTORS and rejects a function, or an accessor, wherever it finds one. A manifest
 * carrying either is not a manifest with an extra field, it is code that arrived through
 * the door marked data, and the whole point of this file is that those are different
 * doors. Descriptors and not values, because reading a property is calling its getter:
 * a walk over values runs the code it came to refuse. That was written the wrong way
 * first and a test caught it; `findCode` has the story.
 *
 * Which is also why the implementation is deliberately absent from the shape. A
 * contribution names a tool; it does not carry one. The `ToolSpec` with its `execute`
 * arrives later, from the component, when somebody decided to activate it.
 *
 * ## What this does NOT claim
 *
 * It does not make a description safe. The strings in here are written by whoever wrote
 * the plugin, they reach the model, and reading them as data rather than as code changes
 * nothing about that. Provenance is `K9` and it is a different mechanism: this one only
 * guarantees that nothing runs while you are deciding.
 */

import { ACTION_CLASSES } from "../enforcement/action-classes.js";
import type { ActionClass } from "../enforcement/action-classes.js";
import type { ToolCategory } from "../tools/registry.js";

/**
 * One tool a plugin says it has.
 *
 * The fields are the ones the runtime reads BEFORE calling anything: what to show the
 * model, what class of thing it is, and whether the loop may run it alongside another.
 * `E32` found tool stubs missing the last two and they are not decoration, so a
 * contribution that omits them is refused rather than defaulted.
 */
export interface ToolContribution {
	readonly name: string;
	/**
	 * Untrusted, and it reaches the prompt.
	 *
	 * Named here rather than left implicit, because a reader of this type is about to
	 * put the string in front of a model. Nothing in this file makes it safe.
	 */
	readonly description: string;
	readonly category: ToolCategory;
	readonly isReadOnly: boolean;
	readonly isConcurrencySafe: boolean;
	/** Permission ids this tool needs, as text. Turning them into keys is a later step. */
	readonly requires?: readonly string[];
	/**
	 * K6: the action classes this capability can produce. Required, and not defaulted.
	 *
	 * This is the envelope, and it is a different question from the permission. A
	 * permission says whether this persona may use the tool at all. An envelope says what
	 * the tool can DO, which is what the second axis weighs against what the persona
	 * declared it will not do. A browser may be permitted and still not be allowed to
	 * POST, because the persona said it does not publish on anyone's behalf.
	 *
	 * Required because the alternative was measured and it is worse than a gap: action
	 * classes are otherwise INFERRED from a regex table over the tool's name and its
	 * arguments, and that table has never seen a plugin. `github:create_issue` infers to
	 * an EMPTY list, so a tool that writes to a remote service is weighed as nothing at
	 * all on the axis that exists to weigh it.
	 *
	 * What a declaration cannot do is shrink anything. It is what the capability ADMITS
	 * to, and the runtime still infers what it can see: the two are unioned, because
	 * trusting a stranger's "at most" is exactly the thing not to do.
	 */
	readonly envelope: readonly string[];
}

/** Everything a plugin contributes, by kind. */
export interface Contributions {
	readonly tools?: readonly ToolContribution[];
}

/** A plugin, as it describes itself. */
export interface PluginManifest {
	readonly name: string;
	readonly version: string;
	/** Service ids it needs to be given, as text. */
	readonly needs?: readonly string[];
	/** Permission ids it needs granted, as text. */
	readonly requires?: readonly string[];
	readonly contributes: Contributions;
}

/** What reading a manifest produced. */
export type ManifestRead =
	| { readonly ok: true; readonly manifest: PluginManifest }
	/** Everything wrong with it, not the first thing. */
	| { readonly ok: false; readonly faults: readonly string[] };

const CATEGORIES: readonly ToolCategory[] = ["fs", "shell", "persona", "net", "mcp", "meta"];

/** A tool name a model can be shown: no spaces, nothing a prompt would read as syntax. */
const TOOL_NAME = /^[a-zA-Z][a-zA-Z0-9_:.-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a value is data all the way down.
 *
 * The structural half of the claim this file makes. A function anywhere inside means
 * something arrived that can run, and a manifest that can run is not a manifest.
 * Depth-limited, because a cyclic value is also not data and a reader that follows one
 * forever is a denial of service wearing a validation check.
 *
 * ## It walks DESCRIPTORS, and the first version did not
 *
 * Written first as a walk over values, with a test claiming it refused a value that runs
 * code merely by being read. The test failed and it was right to: reading a property IS
 * calling its getter, so a walk over values executes exactly the thing it was checking
 * for, finds a perfectly ordinary string, and reports that the manifest is fine. The
 * check had run the code it existed to refuse.
 *
 * So an accessor is refused by its DESCRIPTOR, before anything reads it. That is the
 * only form of the check that can be true: there is no way to ask what a getter returns
 * without running it, and a manifest has no business having one.
 */
function findCode(value: unknown, at: string, depth = 0): string | undefined {
	if (depth > 8) return `${at} is nested deeper than a manifest may be`;
	if (typeof value === "function") return `${at} is a function, and a manifest is data`;
	if (!Array.isArray(value) && !isRecord(value)) return undefined;

	for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
		const where = Array.isArray(value) ? `${at}[${key}]` : `${at}.${key}`;
		if (descriptor.get || descriptor.set) {
			return `${where} is an accessor, and reading a manifest must not run anything`;
		}
		const found = findCode(descriptor.value, where, depth + 1);
		if (found) return found;
	}
	return undefined;
}

function textFaults(value: unknown, at: string): string[] {
	return typeof value === "string" && value.length > 0 ? [] : [`${at} must be a non-empty string`];
}

function stringListFaults(value: unknown, at: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return [`${at} must be an array of strings`];
	return value.every((item) => typeof item === "string")
		? []
		: [`${at} must be an array of strings`];
}

function toolFaults(value: unknown, at: string): string[] {
	if (!isRecord(value)) return [`${at} must be an object`];
	const faults: string[] = [];

	if (typeof value["name"] !== "string" || !TOOL_NAME.test(value["name"])) {
		faults.push(`${at}.name must be a plain identifier a model can be shown`);
	}
	faults.push(...textFaults(value["description"], `${at}.description`));
	if (!CATEGORIES.includes(value["category"] as ToolCategory)) {
		faults.push(`${at}.category must be one of ${CATEGORIES.join(", ")}`);
	}
	// Both, and not defaulted. They decide whether the loop may run this alongside
	// another, and a contribution that stays quiet about that is asking the runtime to
	// guess about concurrency on its behalf.
	for (const flag of ["isReadOnly", "isConcurrencySafe"] as const) {
		if (typeof value[flag] !== "boolean") faults.push(`${at}.${flag} must be a boolean`);
	}
	faults.push(...stringListFaults(value["requires"], `${at}.requires`));

	// K6: present, an array, and every entry a class that exists. An unknown class is
	// refused rather than ignored, because ignoring it turns a typo into silence on the
	// axis the entry was written to raise.
	const envelope = value["envelope"];
	if (!Array.isArray(envelope)) {
		faults.push(`${at}.envelope must be an array of action classes`);
	} else {
		for (const entry of envelope) {
			if (!ACTION_CLASSES.includes(entry as ActionClass)) {
				faults.push(`${at}.envelope has "${String(entry)}", which is not an action class`);
			}
		}
	}

	return faults;
}

/**
 * Reads a manifest, and refuses one it cannot vouch for.
 *
 * Every fault at once rather than the first, which is `E30`'s rule and matters more
 * here: the author of a rejected manifest is usually not us, cannot read our source, and
 * an error that reveals one problem per attempt is indistinguishable from a hostile API.
 *
 * Nothing in here calls anything on the value. `findCode` runs first for that reason: a
 * getter is a function, so a value that would run code merely by being READ is refused
 * before any field is touched.
 */
export function readManifest(value: unknown): ManifestRead {
	if (!isRecord(value)) return { ok: false, faults: ["a manifest must be an object"] };

	const code = findCode(value, "manifest");
	if (code) return { ok: false, faults: [code] };

	const faults: string[] = [
		...textFaults(value["name"], "name"),
		...textFaults(value["version"], "version"),
		...stringListFaults(value["needs"], "needs"),
		...stringListFaults(value["requires"], "requires"),
	];

	const contributes = value["contributes"];
	if (!isRecord(contributes)) {
		faults.push("contributes must be an object, even when it is empty");
	} else if (contributes["tools"] !== undefined) {
		if (!Array.isArray(contributes["tools"])) {
			faults.push("contributes.tools must be an array");
		} else {
			for (const [index, tool] of contributes["tools"].entries()) {
				faults.push(...toolFaults(tool, `contributes.tools[${index}]`));
			}
		}
	}

	return faults.length > 0
		? { ok: false, faults }
		: { ok: true, manifest: value as unknown as PluginManifest };
}

/** Who contributes a name, for a catalogue that has to answer for a collision. */
export interface Contributor {
	readonly plugin: string;
	readonly tool: ToolContribution;
}

/** What is on offer, and what could not be. */
export interface Catalogue {
	/** One entry per tool name, in the order the manifests were given. */
	readonly tools: readonly Contributor[];
	/**
	 * Names more than one plugin claimed, with who claimed them.
	 *
	 * Reported rather than resolved. Picking a winner would make which plugin owns
	 * `read_file` depend on load order, which is the kind of answer that is right in
	 * testing and wrong in a customer's install.
	 */
	readonly collisions: readonly { readonly name: string; readonly claimedBy: readonly string[] }[];
}

/**
 * What a set of manifests offers, worked out without running any of them.
 *
 * This is the whole point of the file in one function: it takes data, returns data, and
 * a plugin whose `activate` throws, hangs or mines bitcoin is catalogued exactly the
 * same as one that does not, because none of them is called.
 */
export function catalogue(manifests: readonly PluginManifest[]): Catalogue {
	const byName = new Map<string, string[]>();
	const tools: Contributor[] = [];

	for (const manifest of manifests) {
		for (const tool of manifest.contributes.tools ?? []) {
			const claimants = byName.get(tool.name);
			if (claimants) {
				claimants.push(manifest.name);
				continue;
			}
			byName.set(tool.name, [manifest.name]);
			tools.push({ plugin: manifest.name, tool });
		}
	}

	const collisions = [...byName.entries()]
		.filter(([, claimants]) => claimants.length > 1)
		.map(([name, claimedBy]) => ({ name, claimedBy: [...claimedBy] }));

	return { tools, collisions };
}
