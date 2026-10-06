/**
 * The workspace wire: the vocabulary the browser, the control plane and the
 * daemon all speak.
 *
 * One vocabulary is what allows a single surface over two execution locations.
 * A persona running on a developer's laptop and one running in a hosted sandbox
 * emit the same events, and nothing downstream knows or cares which produced
 * them. The moment either side speaks a dialect, that stops being true.
 *
 * This module imports nothing from `node:*` on purpose: it runs in the browser,
 * in a Cloudflare Worker and in the daemon alike. Keep it that way.
 *
 * Validation lives with the types rather than at each edge, so a message can
 * never be trusted by one consumer and rejected by another. Every schema here
 * has a `parse` that returns a result instead of throwing: a malformed frame
 * from a socket is an expected event, not an exceptional one.
 */

// ─── Version ────────────────────────────────────────────────────────────────

/**
 * The wire's major version. The server speaks this and the one below it for at
 * least two daemon releases, so an upgrade is never a flag day.
 */
export const WIRE_VERSION = 1;

/** Oldest version the current server still accepts from a daemon. */
export const MIN_SUPPORTED_WIRE_VERSION = 1;

// ─── Envelope ───────────────────────────────────────────────────────────────

export type WireSource = "daemon" | "hosted" | "system" | "user";

export const WIRE_SOURCES: readonly WireSource[] = ["daemon", "hosted", "system", "user"];

/**
 * Wraps every event in the stream.
 *
 * `seq` is assigned by the JobRoom and by nothing else. A producer sends 0 and
 * the room stamps the real number, which is what makes replay, gap-fill and
 * reconnection possible: order is decided in one place or it is not decided at
 * all.
 */
/**
 * Who produced an event, which is not the same question as where it came from.
 *
 * `source` says which machine: a laptop, our cloud, the control plane, a person's
 * click. It has never said WHO, and until this field existed every event arrived
 * with nothing to attribute it to, so anything rendering a transcript had one
 * default available and used it: the persona.
 *
 * That default is a lie in the case that matters most. A workspace job is executed
 * by a vendor agent the persona governs but did not author. Its text, its reasoning
 * and its tool calls are the component's, and showing them as the persona's is how a
 * record ends up quoting somebody else's program as the thing your persona said.
 * This is the ninth gap the reference study named.
 *
 * The vocabulary is deliberately the engine's `Author`, word for word, so the two
 * records can converge later without a translation table in between.
 */
export type WireAuthor =
	/** A person, named. */
	| { kind: "human"; id: string }
	/** The persona itself, acting. */
	| { kind: "persona"; id: string }
	/** A mounted component or a driven agent, by the name it is known by. */
	| { kind: "component"; name: string }
	/** The runtime, doing something nobody asked for. Always says which and why. */
	| { kind: "runtime"; mechanism: string; reason: string };

/** How an author reads, and how two are compared. Matches the engine's `authorId`. */
export function wireAuthorId(author: WireAuthor): string {
	switch (author.kind) {
		case "human":
			return `human:${author.id}`;
		case "persona":
			return `persona:${author.id}`;
		case "component":
			return `component:${author.name}`;
		case "runtime":
			return `runtime:${author.mechanism}`;
	}
}

export interface WireEnvelope {
	/** The job this event belongs to. */
	job_id: string;
	/** Strictly monotonic within a job, from 1. Zero means "not yet assigned". */
	seq: number;
	/** ISO-8601 in UTC. Producer clocks are never trusted for ordering. */
	ts: string;
	source: WireSource;
	/**
	 * Who produced it.
	 *
	 * Optional on the type so a producer built before this field still parses, and
	 * **absent means unknown, never the persona**. A reader that fills the gap with
	 * the persona reintroduces exactly the attribution this field exists to end, and
	 * it would do it silently, on the events least likely to be checked.
	 */
	author?: WireAuthor;
}

// ─── Events ─────────────────────────────────────────────────────────────────

/**
 * The normalised event vocabulary. Adding a kind here is a wire change and
 * needs the version rules above; renaming one is a breaking change.
 *
 * Anything carrying free text (`args_preview`, `output_preview`, `text`) has
 * already passed redaction at the producer. Nothing downstream redacts, which
 * means nothing downstream can forget to.
 */
export type WireEventBody =
	| {
			kind: "persona.session.started";
			persona_id: string;
			persona_version_id: string;
			execution_location: "daemon" | "hosted";
			machine_id?: string;
	  }
	| {
			kind: "persona.session.ended";
			status: "completed" | "failed" | "stopped" | "orphaned";
			reason?: string;
	  }
	| { kind: "persona.layer.applied"; layer: string }
	| { kind: "agent.turn.started"; turn: number }
	| { kind: "agent.turn.ended"; turn: number; summary?: string }
	| { kind: "agent.thought.streamed"; text: string }
	| { kind: "tool.call.requested"; call_id: string; tool: string; args_preview: string }
	/** `rule` names the precedence rule that decided, so a verdict is explicable. */
	| { kind: "tool.call.allowed"; call_id: string; rule: string }
	| { kind: "tool.call.blocked"; call_id: string; rule: string; reason: string }
	| { kind: "tool.call.completed"; call_id: string; ok: boolean; output_preview: string }
	| {
			kind: "gate.opened";
			gate_id: string;
			call_id: string;
			tool: string;
			args_preview: string;
			reason: string;
			/**
			 * Why the policy stopped it, as the class that fired.
			 *
			 * Optional because a daemon written before this field exists and still
			 * connects. Without it the room had nothing to record and filled in a
			 * constant, so every gate in the workspace claimed to be an external write
			 * whatever had actually happened, and a person answering one was reading a
			 * label nobody chose.
			 */
			action_class?: string;
			required_approvals: number;
			route: { roles?: string[]; user_ids?: string[] };
			expires_at: string;
	  }
	| {
			kind: "gate.resolved";
			gate_id: string;
			outcome: "approved" | "denied" | "expired";
			decided_by: string[];
	  }
	| { kind: "envelope.clamped"; field: string; requested: number; applied: number }
	| { kind: "band.crossed"; field: string; from_band: string; to_band: string; prose: string | null }
	/**
	 * A file the step left behind, named and measured and NOT sent.
	 *
	 * The bytes stay on the operator's machine, and that is the decision rather
	 * than a limitation: the connected mode is sold on nothing leaving that
	 * computer, and a delivery that quietly uploaded a client's files would make
	 * that sentence false. So this carries what a person needs to know a file
	 * exists and how big it is, and the file itself stays where it was written.
	 *
	 * `path` is RELATIVE to the project directory, always. An absolute path names
	 * the operator's home directory, their username and often their employer, none
	 * of which the workspace asked for or needs.
	 *
	 * `preview` describes rather than quotes, for the same reason: the first
	 * kilobyte of a file is the file's contents, and the contents are the thing
	 * that does not travel.
	 */
	| {
			kind: "artifact.created";
			artifact_id: string;
			artifact_kind: string;
			preview: string;
			/** Relative to the project directory. Never absolute. */
			path: string;
			/** Size on disk, as stored, so nothing on screen is an estimate. */
			bytes: number;
	  }
	| { kind: "artifact.updated"; artifact_id: string; preview: string }
	| { kind: "intervention.enqueued"; intervention_id: string; user_id: string; body: string }
	| { kind: "intervention.applied"; intervention_id: string }
	| { kind: "steering.granted"; user_id: string; expires_at: string }
	| {
			kind: "steering.released";
			user_id: string;
			reason: "released" | "expired" | "transferred";
	  };

export type WireEvent = WireEnvelope & WireEventBody;

export type WireEventKind = WireEventBody["kind"];

/**
 * Every kind, as data.
 *
 * The adapter that maps the engine's events onto this vocabulary walks this
 * list, so a kind added here without a mapping fails a test rather than
 * silently never being emitted.
 */
export const WIRE_EVENT_KINDS = [
	"persona.session.started",
	"persona.session.ended",
	"persona.layer.applied",
	"agent.turn.started",
	"agent.turn.ended",
	"agent.thought.streamed",
	"tool.call.requested",
	"tool.call.allowed",
	"tool.call.blocked",
	"tool.call.completed",
	"gate.opened",
	"gate.resolved",
	"envelope.clamped",
	"band.crossed",
	"artifact.created",
	"artifact.updated",
	"intervention.enqueued",
	"intervention.applied",
	"steering.granted",
	"steering.released",
] as const satisfies readonly WireEventKind[];

// ─── Browser to server ──────────────────────────────────────────────────────

/** Longest intervention the server accepts. Beyond this the frame is rejected. */
export const MAX_INTERVENTION_LENGTH = 4000;

/**
 * Everything a browser may send, and nothing else.
 *
 * This list is a security boundary, not a convenience. A browser cannot start
 * a job, cannot reach a shell, and cannot assign a sequence number. Anything
 * outside this union is rejected and logged rather than ignored, because a
 * client sending an unknown frame is either broken or probing.
 */
export type BrowserMsg =
	| { type: "pause" }
	| { type: "resume" }
	| { type: "stop" }
	| { type: "gate.approve"; gate_id: string }
	| { type: "gate.deny"; gate_id: string }
	| { type: "intervention.enqueue"; body: string }
	| { type: "steering.request" }
	| { type: "steering.release" }
	/** Flow control and resume point, not per-event delivery confirmation. */
	| { type: "ack"; seq: number };

export type BrowserMsgType = BrowserMsg["type"];

export const BROWSER_MSG_TYPES = [
	"pause",
	"resume",
	"stop",
	"gate.approve",
	"gate.deny",
	"intervention.enqueue",
	"steering.request",
	"steering.release",
	"ack",
] as const satisfies readonly BrowserMsgType[];

// ─── Server to browser ──────────────────────────────────────────────────────

export interface PresenceEntry {
	user_id: string;
	name: string;
	joined_at: string;
}

export type ServerMsg =
	/** Sent when a client is too far behind to catch up event by event. */
	| {
			type: "sync.snapshot";
			events: WireEvent[];
			presence: PresenceEntry[];
			steering: { holder_user_id: string | null; expires_at: string | null };
	  }
	| { type: "sync.gap"; events: WireEvent[] }
	| { type: "presence.changed"; entries: PresenceEntry[] }
	/** `code` is stable and machine readable; `message` names what to do next. */
	| { type: "error"; code: ServerErrorCode; message: string };

export type ServerErrorCode =
	| "wire_incompatible"
	| "unauthorized"
	| "forbidden"
	| "malformed"
	| "unknown_message"
	| "too_large"
	| "rate_limited"
	| "gone";

// ─── Daemon and server ──────────────────────────────────────────────────────

export type HostAgentName = "claude-code" | "codex";

export type DaemonMsg =
	| {
			type: "register";
			wire_version: number;
			machine_name: string;
			os: string;
			daemon_version: string;
			host_agents: Array<{ name: HostAgentName; version: string }>;
			/** Directories the operator consented to locally. Never set remotely. */
			working_dirs: string[];
			cached_policies: Array<{ persona_version_id: string; hash: string }>;
	  }
	| { type: "heartbeat"; running_jobs: string[] }
	/**
	 * `seq` on an outbound event is the daemon's own per-job counter, not the
	 * room's. The room assigns the authoritative sequence for fan-out and echoes
	 * this one back in its `ack`, which is what lets a daemon know exactly how
	 * much of what it sent is durable and where to resume after a drop.
	 */
	| { type: "event"; event: WireEvent }
	/** Only on a local cache miss. Allow and deny normally never leave the machine. */
	| {
			type: "enforcement.query";
			call_id: string;
			persona_version_id: string;
			tool: string;
			args_hash: string;
	  }
	/** Acknowledges what the daemon has applied of what the server sent it. */
	| { type: "ack"; job_id: string; seq: number }
	/**
	 * A worker saying something in the room its run came out of.
	 *
	 * The third way of working in the object model: personas that write to each
	 * other, with no fixed graph and no choreography of ours. The daemon carries
	 * it and decides nothing about it.
	 *
	 * **There is no author on this message, and there must never be one.** The
	 * server derives who is speaking from `job_id`: the job names its version, the
	 * version names its persona, and that persona with the room's subject is the
	 * one instance it can be. A daemon runs on somebody's own computer, so one
	 * that could name its own author could speak in a room as any worker in it,
	 * and a message whose author is an instance is indistinguishable, to everyone
	 * reading that room afterwards, from that worker having said it.
	 *
	 * `to_instance_id` absent is a message that starts nothing: a note left in the
	 * room, which is the cheap half. Naming a worker starts a run, and whether it
	 * may is the server's to decide and to say back.
	 *
	 * Not durable and not acknowledged: unlike an event, this is a request with an
	 * answer, and the answer comes back as `conversation.said`. A daemon that
	 * replayed it on reconnect would say the same thing twice in a room.
	 */
	| {
			type: "conversation.say";
			job_id: string;
			to_instance_id?: string;
			body: string;
	  }
	/**
	 * E24: the persona typing, for a screen that is watching right now.
	 *
	 * A SECOND CHANNEL, and the whole design is that it cannot be mistaken for the
	 * first one. Everything above is durable: it carries `seq`, the server stores it,
	 * acknowledges it, and that is what makes a resume gapless. A token-by-token delta
	 * on that channel would write the same sentence into the record a hundred times in
	 * pieces, and a record of fragments is not a record of what happened.
	 *
	 * So this has NO `seq`, deliberately and not as an omission. There is no sequence
	 * to resume from, nothing to acknowledge, and a server is expected to fan it out to
	 * whoever is connected and then forget it. A dropped delta is not a gap: the
	 * finished message arrives on the durable channel, once, under its own event.
	 *
	 * The consequence a reader should take from the missing field: if you find yourself
	 * wanting to store one of these, the thing you actually want is already on the
	 * other channel.
	 */
	| { type: "live"; job_id: string; delta: string };

/**
 * A step of a service, as the thing running it needs to know about itself.
 *
 * Mirrors what a `ServiceStep` actually is rather than a convenient subset:
 * services are a straight line of contiguous positions, each step is one persona
 * doing one thing, and approval sits on the step that PRODUCES the work rather than
 * on the one that consumes it.
 */
export interface StepContext {
	/** What the service is called, in the words somebody typed. */
	readonly service: string;
	/** Which step this is. One-based and contiguous, as the column is. */
	readonly step: number;
	/** How many the service has, so an agent can tell a middle from an end. */
	readonly of: number;
	/** What this step is called. Absent falls back to the persona's own name. */
	readonly name?: string;
	/**
	 * Whether a person has to say yes before the next step starts.
	 *
	 * Worth telling the agent, and not only the runtime: what somebody approves is
	 * an outcome they can read, and an agent that knows a human is about to read
	 * this writes a different handover than one producing an intermediate nobody
	 * will see.
	 */
	readonly approvalBefore?: boolean;
}

export type ServerToDaemonMsg =
	| { type: "registered"; machine_id: string }
	/**
	 * A policy this machine may be holding is no longer the one in force.
	 *
	 * A workspace's gate rules travel INSIDE the compiled policy and the machine
	 * caches it by persona version for up to its lifetime, which is fifteen
	 * minutes. So raising the bar took effect on the NEXT run and not on the
	 * machines already holding the old bar, and nothing said so. That is a
	 * revocation that does not take effect, which is the semantic rollback the
	 * reference study names, arriving through a cache rather than a checkpoint.
	 *
	 * Sent only when the rules got STRICTER. A relaxation can wait for the next
	 * assignment: nothing unsafe happens because an approval somebody removed is
	 * asked for a few minutes longer, while dropping a cached policy makes the
	 * daemon deny every call for that persona until a new one arrives.
	 *
	 * Dropping and not replacing, deliberately. The new policy is compiled per
	 * run against the workspace it runs in, so sending one here would be a second
	 * place policies are built. `no_policy` is the closed answer, it names itself
	 * in the record, and the next assignment carries the real one.
	 */
	| {
			type: "policy.stale";
			persona_version_ids: string[];
			/** What changed, in words a person reads in the daemon's output. */
			reason: string;
	  }
	/**
	 * What happened to what a worker tried to say.
	 *
	 * `run_id` is the run its message started, or null when it named nobody or
	 * when the room would not start another one. `refused_reason` says which, and
	 * it exists so the agent LEARNS it was refused: one that gets no answer asks
	 * again, and asking again is the loop the ceiling exists to stop.
	 */
	| {
			type: "conversation.said";
			job_id: string;
			message_id: string | null;
			run_id: string | null;
			refused_reason: string | null;
	  }
	| {
			type: "job.assign";
			job_id: string;
			persona_version_id: string;
			policy: CompiledPolicyRef;
			trigger_context: Record<string, unknown>;
			/**
			 * Where this run sits in the service it belongs to.
			 *
			 * The step used to reach the agent as PROSE, glued in front of the
			 * instruction by whoever built the prompt, and that is a loss rather than a
			 * shortcut: an agent cannot ask a paragraph which step it is on, how many
			 * are left, or whether a person has to approve what it produces before the
			 * next one starts. It could only re-read the sentence it was given.
			 *
			 * As data it is one source with two renderings: the daemon writes the
			 * sentence FROM this for an agent that reads only text, and passes the same
			 * fields as protocol metadata for one that can read them. Two renderings of
			 * one fact cannot disagree; a sentence and a field can.
			 *
			 * Absent means a run that is not part of a service, which is most of them:
			 * somebody pressing Run on a persona.
			 */
			step?: StepContext;
			/**
			 * The room this run came out of, when it came out of one.
			 *
			 * Absent for every other origin, which is most of them: a trigger, a step
			 * of a service, somebody pressing Run. Present, it is what lets a worker
			 * answer in the room and address the others in it, and without it the
			 * daemon has a run with no idea it belongs to a conversation.
			 *
			 * `others` carries names because an agent has to be able to say who it is
			 * asking, and an id is not something a model can reason about. The list is
			 * who is IN the room, so a worker cannot address somebody who is not: the
			 * server checks it again, and this is what stops the agent trying.
			 */
			room?: {
				thread_id: string;
				/** The asking worker's own instance, so it can tell itself apart. */
				me: string;
				others: Array<{ instance_id: string; name: string }>;
				/**
				 * Who asked for this run, when it came out of somebody speaking.
				 *
				 * **ASI07, and the reason it is on the wire rather than left implicit.**
				 * A message from another worker becomes this run's prompt, so without
				 * this the agent reads another machine's words in the position its own
				 * operator's instruction occupies. That is prompt injection with a
				 * database behind it, and it does not need an attacker: a worker being
				 * emphatic is enough.
				 *
				 * As data and not as a sentence glued to the front, for the reason
				 * `step` gives: the daemon writes the sentence FROM this, so what the
				 * agent reads and what the record shows cannot disagree.
				 *
				 * `kind: "person"` is somebody typing, which is the ordinary case and
				 * still worth saying out loud: an agent that cannot tell a person from
				 * a peer cannot weigh them differently either.
				 */
				asked_by?:
					| { kind: "person"; name: string }
					| { kind: "worker"; instance_id: string; name: string };
			};
			/**
			 * Which agent runs this persona, when the workspace has an opinion.
			 *
			 * `Machine.hostAgents` has always been a list a machine reports about
			 * itself, read by one screen and deciding nothing: the daemon picked the
			 * first agent it found at `connect` and used it for every job for the rest
			 * of the session. So a workspace could see which agents a machine had and
			 * could not ask for one, and a persona tuned for a particular agent ran on
			 * whatever happened to be installed first.
			 *
			 * A PROPOSAL, like `working_dir`, and refused the same way. The machine
			 * answers with what it has: asking for an agent it did not install is a
			 * refusal with a reason, never a silent fallback to something else. A
			 * persona that says it needs Codex and quietly gets Claude Code is a run
			 * whose result nobody can attribute to a choice.
			 *
			 * Absent means "whatever this machine would have used", which is what
			 * every daemon written before this field did.
			 */
			host_agent?: HostAgentName;
			/**
			 * Which consented directory this job's project works in.
			 *
			 * A PROPOSAL and never an instruction. The daemon ran everything in the
			 * first directory the operator consented to, whatever the project, so a
			 * project was a boundary for memory and for history and stopped being one
			 * at the exact moment the work happened: two clients' work in one folder,
			 * editing each other's files.
			 *
			 * The daemon checks it against what IT consented to and refuses if it
			 * falls outside. That check is not a formality: without it this field is
			 * the workspace choosing where a process starts on somebody else's
			 * machine, which is the one thing the daemon boundary exists to prevent.
			 *
			 * Absent means "wherever you would have run it", which is what every
			 * daemon written before this field did.
			 */
			working_dir?: string;
			/**
			 * Who is doing this: the compiled persona document.
			 *
			 * Without it the daemon starts a host agent with an instruction and nothing
			 * else, which is a generic agent doing a task. The persona would be a row in
			 * a database that no process ever saw, and the identity this product sells
			 * would be decoration.
			 *
			 * It travels in the message rather than being written into a file on the
			 * operator's disk. Writing into somebody's repository to make a run behave
			 * is invasive, it collides with whatever they already have there, and it
			 * leaves the machine dirty when the job ends. The document is a few kilobytes
			 * of prose and this is what it was compiled for.
			 *
			 * Absent means the daemon runs the instruction alone, which is what it did
			 * before this field existed.
			 */
			persona_document?: string;
	  }
	| { type: "job.stop"; job_id: string }
	/**
	 * Hold, and let go.
	 *
	 * A browser has been able to send `pause` and `resume` since this protocol was
	 * written, and neither had a road past the room: the gateway wrote an event
	 * saying somebody asked and the agent carried on. `stop` had the same shape on
	 * that path while a second, working route existed elsewhere, which is worse
	 * than no button: the record said the run was stopped and it was not.
	 *
	 * What a pause can honestly mean is written where it is implemented. It is not
	 * freezing a process somebody else is running.
	 */
	| { type: "job.pause"; job_id: string }
	| { type: "job.resume"; job_id: string }
	| { type: "policy.push"; persona_version_id: string; policy: CompiledPolicyRef }
	| {
			type: "gate.resolved";
			gate_id: string;
			call_id: string;
			outcome: "approved" | "denied" | "expired";
	  }
	/**
	 * Something a person wrote to a persona that is already working.
	 *
	 * `user_id` was added when the daemon first became able to deliver one. The
	 * room already had it, on `intervention.enqueued`, and it was not carried down
	 * because nothing downstream could do anything with an intervention at all.
	 * The turn it becomes is asked for by a PERSON, and a turn that could not say
	 * who asked would have to claim the workspace did, which is the one field the
	 * record rests on being honest.
	 */
	| {
			type: "intervention.deliver";
			job_id: string;
			intervention_id: string;
			body: string;
			user_id: string;
	  }
	/**
	 * Acknowledges durable storage, which is what makes resume gapless.
	 *
	 * `seq` is the daemon's own counter as it sent it, so the daemon can drop
	 * everything up to it and replay only the rest. Without this the daemon
	 * would either replay from the start of the job on every reconnect or trust
	 * that a socket write reached a database, and the second one is how a job
	 * ends up with a record that quietly misses a minute of its life.
	 */
	| { type: "ack"; job_id: string; seq: number }
	/** The daemon closes the socket and deletes its token. */
	| { type: "revoke" };

/**
 * The compiled policy as it crosses the wire.
 *
 * Its shape is owned by the enforcement module, not by the protocol: this
 * package carries it without interpreting it, so a change to how policies are
 * compiled is not a wire change.
 */
export interface CompiledPolicyRef {
	persona_version_id: string;
	/** Content hash, so a daemon can tell whether its cache is current. */
	hash: string;
	rules: unknown;
}

// ─── Parsing ────────────────────────────────────────────────────────────────

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const isString = (v: unknown): v is string => typeof v === "string";

/**
 * Parses a frame from a browser socket.
 *
 * A frame that fails here is rejected and logged. It never throws, because a
 * malformed frame arrives in the normal course of running a server and an
 * uncaught exception would take the room down with it.
 */
export function parseBrowserMsg(raw: unknown): ParseResult<BrowserMsg> {
	try {
		return parseBrowserMsgUnsafe(raw);
	} catch (error) {
		// Frames off a socket come from JSON.parse and cannot carry a throwing
		// accessor, but the contract above says this never throws, and a promise
		// that holds only for the expected caller is not a contract.
		return { ok: false, error: `frame could not be read: ${String(error)}` };
	}
}

function parseBrowserMsgUnsafe(raw: unknown): ParseResult<BrowserMsg> {
	if (!isObject(raw)) return { ok: false, error: "frame is not an object" };
	const type = raw.type;
	if (!isString(type)) return { ok: false, error: "frame has no string `type`" };

	switch (type) {
		case "pause":
		case "resume":
		case "stop":
		case "steering.request":
		case "steering.release":
			return { ok: true, value: { type } as BrowserMsg };

		case "gate.approve":
		case "gate.deny":
			return isString(raw.gate_id)
				? { ok: true, value: { type, gate_id: raw.gate_id } as BrowserMsg }
				: { ok: false, error: `${type} requires a string gate_id` };

		case "intervention.enqueue": {
			if (!isString(raw.body)) return { ok: false, error: "intervention requires a string body" };
			if (raw.body.length === 0) return { ok: false, error: "intervention body is empty" };
			if (raw.body.length > MAX_INTERVENTION_LENGTH) {
				return {
					ok: false,
					error: `intervention body is ${raw.body.length} characters, over the ${MAX_INTERVENTION_LENGTH} limit`,
				};
			}
			return { ok: true, value: { type, body: raw.body } };
		}

		case "ack":
			return typeof raw.seq === "number" && Number.isInteger(raw.seq) && raw.seq >= 0
				? { ok: true, value: { type, seq: raw.seq } }
				: { ok: false, error: "ack requires a non-negative integer seq" };

		default:
			// Named rather than lumped into "malformed": a client sending an
			// unknown type is either out of date or probing, and the two are worth
			// telling apart in the log.
			return { ok: false, error: `unknown message type: ${type}` };
	}
}

/**
 * Parses a frame arriving at a browser from the control plane.
 *
 * The symmetric counterpart of `parseBrowserMsg`, and it exists for the same
 * reason. A browser that trusts whatever JSON arrives on its socket is the same
 * gap as a server that trusts whatever a client sends: a proxy, an extension,
 * or a stale deployment can put a frame on that wire, and the client that
 * reads it without checking will build its interface out of whatever it got.
 *
 * Also never throws. A malformed frame is an ordinary event on a long-lived
 * socket, and an uncaught exception in an onmessage handler takes the view down
 * with it.
 *
 * Accepts either a JSON string, which is what a WebSocket delivers, or an
 * already-parsed value, so a caller that has one does not have to re-encode it.
 */
export function parseServerMsg(raw: unknown): ParseResult<ServerMsg> {
	try {
		return parseServerMsgUnsafe(typeof raw === "string" ? JSON.parse(raw) : raw);
	} catch (error) {
		return { ok: false, error: `frame could not be read: ${String(error)}` };
	}
}

function parseServerMsgUnsafe(raw: unknown): ParseResult<ServerMsg> {
	if (!isObject(raw)) return { ok: false, error: "frame is not an object" };
	const type = raw.type;
	if (!isString(type)) return { ok: false, error: "frame has no string `type`" };

	switch (type) {
		case "sync.snapshot": {
			const events = parseEvents(raw.events);
			if (!events.ok) return events;
			if (!Array.isArray(raw.presence)) {
				return { ok: false, error: "sync.snapshot requires a presence array" };
			}
			if (!isObject(raw.steering)) {
				// A snapshot without steering would leave a client unable to say
				// whether anyone is driving, which reads as "nobody" and lets two
				// people act at once.
				return { ok: false, error: "sync.snapshot requires steering" };
			}
			return {
				ok: true,
				value: {
					type,
					events: events.value,
					presence: raw.presence as ServerMsg extends { presence: infer P } ? P : never,
					steering: raw.steering as { holder_user_id: string | null; expires_at: string | null },
				},
			};
		}

		case "sync.gap": {
			const events = parseEvents(raw.events);
			return events.ok ? { ok: true, value: { type, events: events.value } } : events;
		}

		case "presence.changed":
			return Array.isArray(raw.entries)
				? { ok: true, value: { type, entries: raw.entries as PresenceEntry[] } }
				: { ok: false, error: "presence.changed requires an entries array" };

		case "error":
			return isString(raw.code) && isString(raw.message)
				? {
						ok: true,
						value: { type, code: raw.code as ServerErrorCode, message: raw.message },
					}
				: { ok: false, error: "error requires a string code and message" };

		default:
			return { ok: false, error: `unknown message type: ${type}` };
	}
}

/**
 * Events carried inside a sync frame.
 *
 * Each one needs a job, a sequence and a kind, because those three are what
 * every consumer indexes on: an event missing any of them cannot be ordered,
 * cannot be attributed, and would sit in a reducer as a permanent gap.
 */
function parseEvents(raw: unknown): ParseResult<WireEvent[]> {
	if (!Array.isArray(raw)) return { ok: false, error: "events is not an array" };

	for (const [index, event] of raw.entries()) {
		if (!isObject(event)) return { ok: false, error: `event ${index} is not an object` };
		if (!isString(event.job_id)) return { ok: false, error: `event ${index} has no job_id` };
		if (!isString(event.kind)) return { ok: false, error: `event ${index} has no kind` };
		if (typeof event.seq !== "number" || !Number.isInteger(event.seq) || event.seq < 1) {
			return { ok: false, error: `event ${index} has no assigned seq` };
		}
	}

	return { ok: true, value: raw as WireEvent[] };
}

/** True when a daemon reporting `version` can talk to this server. */
export function isWireVersionSupported(version: unknown): boolean {
	return (
		typeof version === "number" &&
		Number.isInteger(version) &&
		version >= MIN_SUPPORTED_WIRE_VERSION &&
		version <= WIRE_VERSION
	);
}

/**
 * The refusal a server sends a daemon it cannot talk to.
 *
 * It names the versions rather than saying "incompatible", so the operator
 * learns what to do from the message instead of from a support thread.
 */
export function wireIncompatibleError(reported: unknown): Extract<ServerMsg, { type: "error" }> {
	return {
		type: "error",
		code: "wire_incompatible",
		message:
			`This server speaks wire version ${WIRE_VERSION}` +
			(MIN_SUPPORTED_WIRE_VERSION < WIRE_VERSION
				? ` and accepts from ${MIN_SUPPORTED_WIRE_VERSION}`
				: "") +
			`. The daemon reported ${JSON.stringify(reported)}. Upgrade with: npm i -g personaxis`,
	};
}

/** Narrows an event to a kind, for consumers switching on one. */
export function isWireEventKind<K extends WireEventKind>(
	event: WireEvent,
	kind: K,
): event is WireEvent & { kind: K } {
	return event.kind === kind;
}
