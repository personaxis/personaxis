/**
 * `run_service`: a persona runs one of the services it delivers, when a request is exactly that service.
 *
 * ## Why this exists
 *
 * E73. A service only ran outside the conversation, with `personaxis service run`, so a person who asked a
 * persona in plain words for what one of its services delivers got the persona improvising the steps instead.
 * It follows the same direction as `use_skill`: a persona is spoken to in plain
 * language and decides what to use, and a command is not the way in.
 *
 * ## Asked every time
 *
 * A service writes several files and spends several model calls, so the person is asked before every run.
 * The gate asks whatever the posture. A posture that lets an ordinary
 * write through without asking does not let a service through, because the loop's verdict is the strictest of
 * its guards and consent only tightens it. What the person approves is written in the reason: which service,
 * how many steps, what it leaves, and the request it runs on.
 *
 * ## What it does not do
 *
 * It runs nothing itself. Running a service needs a host that can run a persona turn per step, check the files
 * and write the journal, which is what `service run` does on this machine, so the host lends `run` and this
 * tool only decides whether a call may use it. Every step is a governed turn with its own gate. A persona that
 * delivers no service is never shown the tool, and neither a delegated sub-task nor a service step is lent
 * `run`, so a service cannot start another from inside a turn.
 */

import type { MapService } from "../run/work-map.js";
import type { CommandClass, CommandVerdict } from "../sandbox.js";
import type { ToolSpec } from "./registry.js";

/** The name the catalogue, the index and the decision step use. One owner, so a rename cannot half-happen. */
export const RUN_SERVICE_TOOL = "run_service";

export interface RunServiceInput {
	/** The service's address, as the persona's index lists it. */
	readonly service: string;
	/** What the client asked for, in their own words. */
	readonly brief: string;
}

export interface RunServiceToolOptions {
	/** The services this persona delivers, read when a call is gated or run, the same way its index reads them. */
	readonly services: () => readonly MapService[];
	/** The host's way to run one to its end. What it returns is what the persona is told about the run. */
	readonly run: (input: RunServiceInput) => Promise<string>;
}

/** A service writes files through its steps, and its steps call the model. Nothing destructive, nothing outside. */
const SERVICE_CLASS: CommandClass = { writesFiles: true, network: true, destructive: false, escapesWorkspace: false };

type Read = { readonly ok: true; readonly service: MapService; readonly brief: string } | { readonly ok: false; readonly reply: string };

function readCall(args: Record<string, unknown>, services: readonly MapService[]): Read {
	const address = typeof args.service === "string" ? args.service.trim() : "";
	const service = services.find((entry) => entry.address === address);
	if (!service) {
		const names = services.map((entry) => entry.address).join(", ");
		return { ok: false, reply: `you deliver no service called "${address}". Your services: ${names || "none"}.` };
	}
	const brief = typeof args.brief === "string" ? args.brief.trim() : "";
	if (!brief) return { ok: false, reply: "say what the client asked for in `brief`, in their own words: a service runs on the request." };
	return { ok: true, service, brief };
}

export function runServiceTool(options: RunServiceToolOptions): ToolSpec {
	return {
		name: RUN_SERVICE_TOOL,
		category: "persona",
		description:
			"Run one of the services you deliver on the client's request, when the request is what that service delivers. " +
			"The person approves every run before it starts; then its steps run in order and leave the files the service names.",
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["service", "brief"],
			properties: {
				service: { type: "string", description: "The service's address, exactly as your index lists it." },
				brief: { type: "string", description: "What the client asked for, in their own words." },
			},
		},
		isReadOnly: false,
		isConcurrencySafe: false,
		// The tool itself touches nothing: every file is written by a step, and every call a step makes is gated on its own.
		envelope: [],
		gate: (args: Record<string, unknown>): CommandVerdict => {
			const got = readCall(args, options.services());
			if (!got.ok) return { decision: "deny", reason: got.reply, class: SERVICE_CLASS };
			const { service, brief } = got;
			const leaves = service.delivers.length > 0 ? `leaves ${service.delivers.join(", ")}` : "declares no files";
			const shown = brief.length > 240 ? `${brief.slice(0, 240)}...` : brief;
			return {
				decision: "ask",
				reason: `run the service "${service.name}" (${service.steps} step${service.steps === 1 ? "" : "s"}, ${leaves}) on this request: "${shown}"`,
				class: SERVICE_CLASS,
			};
		},
		execute: async (args: Record<string, unknown>): Promise<string> => {
			const got = readCall(args, options.services());
			if (!got.ok) return `error: ${got.reply}`;
			try {
				return await options.run({ service: got.service.address, brief: got.brief });
			} catch (e) {
				return `error: the service could not run: ${e instanceof Error ? e.message : String(e)}`;
			}
		},
	};
}
