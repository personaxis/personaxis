/**
 * The built-in tools, as components the kernel mounts.
 *
 * The kernel has been finished since M4 and holds nothing: 1,325 lines whose only
 * callers are one error helper and one bridge. M4's row promised exactly this and its
 * commit produced `assemble()`, which does not use it. So this is the promise, kept.
 *
 * ## What changes for a person using the product
 *
 * A tool whose permission is withdrawn STOPS BEING OFFERED, instead of being offered
 * and then refused.
 *
 * That difference is not cosmetic and it is not about tidiness. A model handed a tool
 * it may not use will use it, be refused, and try again in a slightly different shape,
 * which is the loop the breaker exists to stop. It also spends the turn's budget on
 * calls that were never going to run, and fills the transcript with refusals that read
 * like the persona failing rather than like the operator's configuration holding.
 *
 * The gate does not go anywhere. A tool that IS offered still meets both axes on every
 * call. This is the layer above: which tools exist for this persona, in this workspace,
 * right now.
 *
 * ## Why permissions and availability are one mechanism
 *
 * `keys.ts` makes the argument and this is where it pays. The reference kernel has one
 * axis, "is the service there", and its capability layer keeps rediscovering that a
 * probe answering no for a second deletes a toolset from whatever agent happened to be
 * starting. Ours asks a question with a SUBJECT: may this persona, in this workspace,
 * on this machine. A withdrawn permission suspends exactly its dependents, and the
 * catalogue is recomputed rather than an agent restarted.
 */

import {
	Kernel,
	PERMISSIONS,
	permissionKey,
	type Component,
	type PermissionKey,
	type PermissionSource,
} from "../kernel/index.js";
import { editFileTool } from "./builtin/edit-file.js";
import { finishTool } from "./builtin/finish.js";
import { listDirTool } from "./builtin/list-dir.js";
import { readFileTool } from "./builtin/read-file.js";
import { runCommandTool } from "./builtin/run-command.js";
import { writeFileTool } from "./builtin/write-file.js";
import { catalogue, readManifest, type PluginManifest } from "../kernel/manifest.js";
import { CORE_VERSION } from "../generated/version.js";
import type { SandboxPosture } from "../security/consent.js";
import type { ToolSpec } from "./registry.js";

/**
 * The permissions a built-in tool can need.
 *
 * Four, not six, because two tools share a permission and one needs none. The
 * granularity is what an operator would actually want to withhold: reading is not
 * writing, writing a file is not running a command. A permission per tool would be a
 * list nobody could reason about, and a single "tools" permission would be a switch
 * that turns the persona off.
 */
export const TOOL_PERMISSIONS = {
	readFiles: permissionKey("tools.read"),
	writeFiles: permissionKey("tools.write"),
	runCommands: permissionKey("tools.command"),
} as const;

/** Which permission each built-in needs, or none. */
const NEEDED: ReadonlyArray<{ tool: ToolSpec; permission?: PermissionKey }> = [
	{ tool: readFileTool, permission: TOOL_PERMISSIONS.readFiles },
	{ tool: listDirTool, permission: TOOL_PERMISSIONS.readFiles },
	{ tool: writeFileTool, permission: TOOL_PERMISSIONS.writeFiles },
	{ tool: editFileTool, permission: TOOL_PERMISSIONS.writeFiles },
	{ tool: runCommandTool, permission: TOOL_PERMISSIONS.runCommands },
	// `finish` needs nothing. A persona that cannot say it is done is a persona that
	// cannot stop, and no operator wants to withhold that.
	{ tool: finishTool },
];

/**
 * One tool, as a component.
 *
 * `activate` registers the tool in the live catalogue through the component's own
 * SCOPE, which is what makes withdrawal work without any withdrawal code: the kernel
 * unwinds the scope when the permission goes, and the registration goes with it. That
 * is `EffectScope` doing the job it was written for, rather than a deactivate hook
 * somebody has to remember to write correctly.
 */
function componentFor(
  entry: { tool: ToolSpec; permission?: PermissionKey },
  offer: (tool: ToolSpec) => () => void,
): Component {
	return {
		name: `tool.${entry.tool.name}`,
		...(entry.permission ? { requires: [entry.permission] } : {}),
		activate: (context) => {
			context.scope.use(offer(entry.tool));
		},
	};
}

/**
 * K1: the built-ins, described as data, through the same door a plugin comes through.
 *
 * Two reasons it is here rather than in a fixture. The catalogue a person reads and the
 * catalogue the kernel mounts have to be the same list, and the surest way to keep them
 * the same is to derive one from the other rather than write it twice. And a manifest
 * reader that has never accepted a real manifest is a reader nobody has checked: ours
 * goes through `readManifest` exactly as a stranger's would, so a built-in with a
 * description the reader would refuse fails at mount instead of in a prompt.
 */
export function builtinManifest(): PluginManifest {
	const read = readManifest({
		name: "personaxis.builtin",
		version: CORE_VERSION,
		contributes: {
			tools: NEEDED.map((entry) => ({
				name: entry.tool.name,
				description: entry.tool.description,
				category: entry.tool.category,
				isReadOnly: entry.tool.isReadOnly,
				isConcurrencySafe: entry.tool.isConcurrencySafe,
				...(entry.permission ? { requires: [entry.permission.id] } : {}),
			})),
		},
	});

	// Ours, so a failure here is a mistake in this file rather than somebody else's
	// input, and it should stop the process rather than degrade the catalogue.
	//
	// UNOBSERVABLE while the list above is correct, and said out loud rather than
	// covered by a test that would only look like one: a negative control that removes
	// this throw leaves every test green, because our manifest validates and the branch
	// is never taken. What it guards is a built-in added later with, say, a category the
	// reader refuses, and reaching it from a test would mean manufacturing that mistake
	// inside the module. The reader itself is tested against every shape it refuses.
	if (!read.ok) {
		throw new Error(`the built-in manifest does not validate: ${read.faults.join("; ")}`);
	}
	return read.manifest;
}

/** A live catalogue: the tools whose components are currently active. */
export interface ToolBench {
	/** What the model should be offered right now. */
	readonly tools: readonly ToolSpec[];
	/** Stops every component and empties the catalogue. */
	close(): void;
}

/**
 * Mounts the built-ins on a kernel and hands back the live catalogue.
 *
 * The order the tools come back in is the order they are declared, not the order they
 * happened to activate. A catalogue that reshuffled itself between turns would change
 * the prompt prefix for no reason a person could see, which is the cache discipline
 * E5 established one file over.
 */
export function mountBuiltins(kernel: Kernel, permissions: PermissionSource): ToolBench {
	// K1: read the catalogue before mounting anything, which is the whole point of a
	// manifest. Two tools with one name would both be offered and the model would be
	// shown an ambiguous name whose meaning depends on load order. Checked on our own
	// list because that is the list this function mounts; it starts mattering the day a
	// second manifest joins it, and by then it is already here.
	const collisions = catalogue([builtinManifest()]).collisions;
	if (collisions.length > 0) {
		const named = collisions.map((c) => `${c.name} (${c.claimedBy.join(", ")})`).join("; ");
		throw new Error(`two tools claim one name: ${named}`);
	}

	const offered = new Set<string>();
	const offer = (tool: ToolSpec) => {
		offered.add(tool.name);
		return () => offered.delete(tool.name);
	};

	kernel.provide(PERMISSIONS, permissions);
	const unmounts = NEEDED.map((entry) => kernel.mount(componentFor(entry, offer)));

	return {
		get tools() {
			return NEEDED.filter((entry) => offered.has(entry.tool.name)).map((entry) => entry.tool);
		},
		close: () => {
			for (const unmount of unmounts) unmount();
		},
	};
}

/**
 * A source that answers from a plain set of granted permissions.
 *
 * The simple case, and the one every caller has today: an operator's configuration
 * says what this persona may do, and nothing changes it mid-run. A source that reads a
 * workspace or a machine registry replaces this one without any component knowing.
 */
export function grantedPermissions(granted: readonly PermissionKey[]): PermissionSource {
	const ids = new Set(granted.map((permission) => permission.id));
	return {
		answer: (permission) =>
			ids.has(permission.id)
				? { granted: true }
				: {
						granted: false,
						reason: `this persona was not granted ${permission.id}`,
					},
	};
}

/** Everything a persona with no restrictions may do, which is every built-in. */
export const ALL_TOOL_PERMISSIONS: readonly PermissionKey[] = Object.values(TOOL_PERMISSIONS);

/**
 * What a sandbox posture grants, as permissions.
 *
 * The translation exists because the persona already declares a posture and nobody
 * should have to write the same intent twice. `read-only` means read-only: a persona
 * that declared it is not handed a file writer it would be refused for using.
 *
 * `workspace-write` gets commands as well as writes, which is the one line worth
 * arguing about. It is the posture that means "work in this repository", and working
 * in a repository is running its tests. Withholding commands there would leave a
 * persona that can edit code and cannot check it, which is not a safer persona, it is
 * a persona that guesses.
 *
 * The gate still applies on every call. This decides what is OFFERED; `evaluate` and
 * the two axes decide what runs.
 */
export function permissionsFor(sandbox: SandboxPosture): readonly PermissionKey[] {
	if (sandbox === "read-only") return [TOOL_PERMISSIONS.readFiles];
	if (sandbox === "workspace-write") {
		return [TOOL_PERMISSIONS.readFiles, TOOL_PERMISSIONS.writeFiles, TOOL_PERMISSIONS.runCommands];
	}
	return ALL_TOOL_PERMISSIONS;
}
