/**
 * Being an MCP client, which is how the catalogue stops being six tools.
 *
 * We have been an MCP *server* since early on: `@personaxis/mcp` exposes a live
 * persona to a host. This is the other direction, and it is the one that closes a
 * measured gap. The engine ships six built-in tools. The reference agent this project
 * studies has 129. Writing 123 more is years of work that somebody else has already
 * done and published behind a protocol, and the same argument won for ACP in phase
 * 11: reach the ecosystem through the protocol rather than reimplement its contents.
 *
 * `personaxis mcp add` has registered servers into the config since V2-F3.B11, and the
 * header of that command has said "mounting the registered servers' tools into the
 * live agent loop is the follow-up" ever since. This is the follow-up.
 *
 * ## What a mounted tool is, and what it is not
 *
 * It is an ordinary `ToolSpec` in the ordinary catalogue. `mcpToolToSpec` does that
 * mapping and already existed; nothing here re-does it. That uniformity is the point:
 * tool subsetting, the interceptor, the injection defence and, since E2, the two-axis
 * gate all treat a mounted tool exactly like a built-in one, because there is no
 * second path for them to miss.
 *
 * It is NOT trusted. Three separate reasons, and each has its own answer:
 *
 *   **A server is somebody else's program running on this machine.** Starting one is
 *   a spawn. The operator registered it by hand with `mcp add`, which is the consent,
 *   and nothing here discovers or starts a server the operator did not name.
 *
 *   **A server names its own tools.** Every name is prefixed with the server's, so a
 *   server advertising `write_file` becomes `github:write_file` and cannot shadow the
 *   built-in the model already knows. Without the prefix a registered server could
 *   silently replace the engine's own file writer.
 *
 *   **Its output is untrusted text.** It goes through the same ingest path as any
 *   other tool output, so the injection defence sees it. What this file adds is a
 *   size bound, because a server returning a megabyte would spend the context window
 *   rather than the model's attention.
 *
 * ## Why failures are per server and never fatal
 *
 * A registered server that is not installed, or crashes on start, or hangs, must cost
 * its own tools and nothing else. The alternative is a persona that will not start
 * because of something the operator added to try it out three weeks ago, and the
 * operator has no way to tell which of five servers did it.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mcpToolToSpec, type McpToolDescriptor, type ToolSpec } from "@personaxis/core";

import { loadConfig } from "../config.js";
import { version } from "../generated/assets.js";

/** A server as the config records it. */
export interface McpServerSpec {
	command: string;
	args?: string[];
	env?: Record<string, string>;
}

/**
 * How long a server has to come up and say what it offers.
 *
 * Short, because this is on the path to a persona answering its first question and a
 * server that is not going to work should cost seconds rather than a minute. Its own
 * constant rather than the SDK's default so the number is visible to whoever waits.
 */
export const MOUNT_TIMEOUT_MS = 10_000;

/** How much of one tool result reaches the model. */
export const MAX_RESULT = 16_000;

/** What a server contributed, and how to stop it. */
export interface MountedServer {
	readonly name: string;
	readonly tools: readonly ToolSpec[];
	close(): Promise<void>;
}

/** A server that did not come up, named, with what went wrong. */
export interface MountFailure {
	readonly name: string;
	readonly reason: string;
}

export interface Mounted {
	/** Every tool from every server that came up, ready for the catalogue. */
	readonly tools: readonly ToolSpec[];
	readonly servers: readonly MountedServer[];
	/** The ones that did not, so an operator is told rather than left guessing. */
	readonly failures: readonly MountFailure[];
	/** Stops every server. Safe to call twice. */
	close(): Promise<void>;
}

/**
 * The text a model sees from one tool result.
 *
 * Only the text parts. An MCP result may carry images and embedded resources, and a
 * model reached through a text tool protocol cannot act on those: rendering them as
 * `[image]` says what happened, where dropping them silently would leave the model
 * reasoning about a result it never saw the shape of.
 */
export function textOf(result: { content?: unknown; isError?: unknown }): string {
	const parts = Array.isArray(result.content) ? result.content : [];
	const rendered = parts
		.map((part) => {
			const item = part as { type?: string; text?: string; mimeType?: string };
			if (item.type === "text" && typeof item.text === "string") return item.text;
			return `[${item.type ?? "unknown"}${item.mimeType ? ` ${item.mimeType}` : ""}]`;
		})
		.join("\n");
	const body = rendered.length > MAX_RESULT ? `${rendered.slice(0, MAX_RESULT)}\n[truncated]` : rendered;
	// The server's own error flag is kept rather than turned into a throw. A tool that
	// failed is a step the model can react to; a throw is a run that ends.
	return result.isError === true ? `error from the MCP server: ${body}` : body;
}

/** The transport the SDK connects over, named from the method that takes it. */
type Transport = Parameters<Client["connect"]>[0];

/** How this client is reached, so a test can supply one that starts no process. */
export interface MountOptions {
	/**
	 * Builds the transport. Defaults to stdio, which starts the server's command.
	 *
	 * Injected for the same reason `mcpToolToSpec` injects its `call`: a test that had
	 * to start a real server would be testing the operator's PATH, and the thing worth
	 * pinning here is what happens to the tools a server advertises.
	 */
	readonly transportFor?: (name: string, spec: McpServerSpec) => Transport;
	readonly timeoutMs?: number;
}

/**
 * Connects to one server and adapts everything it advertises.
 *
 * Throws when the server does not come up, which is caught by the caller and reported
 * per server. Throwing here rather than returning an empty list keeps "offered no
 * tools" and "could not be reached" apart, and an operator debugging a server needs
 * that difference more than anything else this function could tell them.
 */
export async function mountServer(
	name: string,
	spec: McpServerSpec,
	options: MountOptions = {},
): Promise<MountedServer> {
	const client = new Client(
		{ name: "personaxis", version },
		// Nothing declared. We consume tools; we do not offer sampling or roots back,
		// and declaring a capability we do not implement invites a server to use it.
		{ capabilities: {} },
	);

	const transport =
		options.transportFor?.(name, spec) ??
		new StdioClientTransport({
			command: spec.command,
			...(spec.args ? { args: [...spec.args] } : {}),
			...(spec.env ? { env: { ...spec.env } } : {}),
			// Piped rather than inherited, which is the SDK's default. A server writing
			// to stderr would otherwise print into the operator's session, in the middle
			// of a persona's answer, with nothing saying which server it came from.
			stderr: "pipe",
		});

	const timeout = options.timeoutMs ?? MOUNT_TIMEOUT_MS;
	await client.connect(transport, { timeout });
	const listed = await client.listTools(undefined, { timeout });

	const tools = listed.tools.map((descriptor) =>
		mcpToolToSpec(name, descriptor as McpToolDescriptor, async (toolName, args) => {
			try {
				const result = await client.callTool({ name: toolName, arguments: args });
				return textOf(result as { content?: unknown; isError?: unknown });
			} catch (error) {
				// The server died, timed out, or refused. Reported as the tool's result so
				// the model can try something else, rather than as a throw that ends a run
				// somebody was in the middle of.
				return `error calling ${name}:${toolName}: ${error instanceof Error ? error.message : String(error)}`;
			}
		}),
	);

	return {
		name,
		tools,
		close: async () => {
			try {
				await client.close();
			} catch {
				/* a server that already died does not need closing twice */
			}
		},
	};
}

/**
 * Mounts every registered server, keeping what works.
 *
 * Sequential rather than parallel, and that is a real choice. Starting five unknown
 * programs at once on somebody's laptop is five sets of stdio, five node processes and
 * a spike the operator did not ask for, in exchange for a few seconds at startup. The
 * budget being protected here is the operator's machine, not the mount.
 */
export async function mountAll(
	servers: Record<string, McpServerSpec>,
	options: MountOptions = {},
): Promise<Mounted> {
	const mounted: MountedServer[] = [];
	const failures: MountFailure[] = [];

	for (const [name, spec] of Object.entries(servers)) {
		try {
			mounted.push(await mountServer(name, spec, options));
		} catch (error) {
			failures.push({ name, reason: error instanceof Error ? error.message : String(error) });
		}
	}

	return {
		tools: mounted.flatMap((server) => [...server.tools]),
		servers: mounted,
		failures,
		close: async () => {
			await Promise.all(mounted.map((server) => server.close()));
		},
	};
}

/**
 * The servers this project and this user registered, mounted.
 *
 * Project over global, which is the precedence `personaxis mcp list` already prints,
 * so a repository can pin a server the machine also has under the same name and get
 * the repository's version. Two orderings of the same two configs would be two ideas
 * about which server the operator meant.
 *
 * Failures are reported through a callback rather than printed, because this is
 * reached from the REPL, from a headless run, and from a daemon, and only one of the
 * three has somebody watching a terminal.
 */
export async function mountRegistered(
	options: MountOptions & { onFailure?: (failure: MountFailure) => void } = {},
): Promise<Mounted> {
	const servers = {
		...(loadConfig("global").mcpServers ?? {}),
		...(loadConfig("project").mcpServers ?? {}),
	};
	const mounted = await mountAll(servers, options);
	for (const failure of mounted.failures) options.onFailure?.(failure);
	return mounted;
}
