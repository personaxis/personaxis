/**
 * `personaxis service`, running a service on this machine, including services that contain services.
 *
 * This file wires things that already exist and invents none of them. The decision about what runs
 * next is `service.runService` in the engine, which sits on `advance` and `handoverText` moved from
 * the SaaS unchanged.
 *
 * A persona step is a working turn, the one the REPL and the ACP binary run through
 * `run.runnerFor`: the persona's compiled policy decides every tool call before it happens, a call
 * that wants a person asks the person at this terminal or is refused, and the turn is written to
 * the persona's record. It is NOT the reply `personaxis -p` gives, which answers without tools, and
 * the first version of this file used that one: a service whose steps could not act was a chain of
 * prompts, and the gate this product is about was never in the room.
 *
 * Then one governed tick of the persona's living loop, through `runObserve`, on what the step put
 * in front of the persona. That is what makes the state move across a service.
 *
 * A service is a JSON file in `.personaxis/services/<address>.json`, in the shape of the SaaS's
 * `ServiceTemplate`, plus `serviceRef` for a step done by another service. The run's journal is
 * written next to the work, which is where the durable-execution ADR puts it.
 *
 * E97: a run that waits, for an approval or for the answer to a question one of its steps asked, is picked
 * up with `service resume` from its journal, through the engine's `service.resumeService`, which is the one
 * function every surface uses. `--json` gives a program the facts a person reads, the question and its
 * options included, and asks nobody at this terminal anything.
 */

import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import { EventBus, pathEscapesWorkspace, personaResourceRoots, policyFromFrontmatter, renderQuestion, resolveModel, run, service, type ApprovalAnswer, type LoopEvent } from "@personaxis/core";

import { buildAwarenessBlock } from "../repl/awareness.js";
import { friendlyProviderError } from "../repl/render.js";
import { holdPresence } from "../presence-session.js";
import { meterModelCalls, usageBetween, type ModelUsage } from "../usage-meter.js";
import { runObserve } from "./observe.js";

type StopReason = run.StopReason;
type Meter = ReturnType<typeof meterModelCalls>;

const SERVICES_DIR = join(".personaxis", "services");
const PERSONAS_DIR = join(".personaxis", "personas");

function servicePath(root: string, address: string): string {
	return join(root, SERVICES_DIR, `${address}.json`);
}

function personaPath(root: string, ref: string): string {
	return join(root, PERSONAS_DIR, ref, "personaxis.md");
}

function loadService(root: string, address: string): service.ServiceDef | undefined {
	const path = servicePath(root, address);
	if (!existsSync(path)) return undefined;
	const raw = JSON.parse(readFileSync(path, "utf8")) as service.ServiceDef;
	// The file's own name is the address. A file whose `address` field disagrees would let two
	// services answer to the same name, which is the collision a registry exists to prevent.
	return { ...raw, address };
}

async function ask(question: string): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const answer = (await rl.question(chalk.yellow(question))).trim().toLowerCase();
	rl.close();
	return answer === "y" || answer === "yes";
}

/**
 * Ask a person on the terminal, or say nobody can answer. Never answers for them. `interactive` is false when
 * a program reads the output (`--json`): a program is not a person at this terminal, whatever the terminal is.
 */
async function approveOnTerminal(input: { serviceName: string; position: number }, interactive: boolean): Promise<"approved" | "rejected" | "unavailable"> {
	if (!interactive || !process.stdin.isTTY) return "unavailable";
	return (await ask(`  approve step ${input.position} of ${input.serviceName}? [y/N] `)) ? "approved" : "rejected";
}

/**
 * A tool call the persona's policy wants a person for. Asked on the terminal, or refused with the
 * reason written down, the way a delegated sub-task refuses: nobody was there, so nobody said yes.
 */
async function approveToolOnTerminal(tool: string, reason: string, interactive: boolean): Promise<ApprovalAnswer> {
	if (!interactive || !process.stdin.isTTY) {
		return { decision: "deny", reason: "no person at this terminal to approve it, and a service never approves on their behalf" };
	}
	return (await ask(`  allow ${tool}? ${reason} [y/N] `)) ? "approve" : { decision: "deny", reason: "the person at this terminal was asked and said no" };
}

/**
 * E84: the question a step's turn stopped at, as the reason its run waits, or null when every question it
 * asked was answered. Written out whole, options included, because whoever reads a waiting run (a person, an
 * agent, an app reading the journal) needs to see what is missing to be able to give it.
 */
export function waitingForAnswer(
	questions: readonly (Parameters<typeof renderQuestion>[0] & { readonly answer?: string })[] | undefined,
): string | null {
	const pending = (questions ?? []).find((asked) => asked.answer === undefined);
	return pending === undefined ? null : `waiting for an answer: ${renderQuestion(pending)}`;
}

/**
 * How a turn's end maps onto a step's. Exported for its test.
 *
 * A turn that closed early on a ceiling or a declared rule still delivered what it had, and says
 * so. Every other early end fails the step: work the gate cut short, handed on as if it were done,
 * is the one thing a service must not do, because the next step builds on it.
 */
export function stepOutcomeOf(stopReason: StopReason, answer: string): { outcome: "completed" | "failed"; reason: string | null } {
	if (stopReason === "answered") return { outcome: "completed", reason: null };
	if ((stopReason === "budget" || stopReason === "stopped") && answer.trim().length > 0) {
		return { outcome: "completed", reason: `closed early (${stopReason}) with what it had` };
	}
	return { outcome: "failed", reason: `the turn ended ${stopReason}` };
}

/**
 * Which of a step's declared files are in the service's folder, written at or after `since`.
 * Exported for its test.
 *
 * E60: read from the disk, never from what the agent said. A path that leaves the folder is
 * missing, whatever is there. A filesystem that keeps times in two-second steps (FAT) could round
 * a fresh write down past `since`, which fails the step rather than passing it.
 */
export function producedIn(root: string, paths: readonly string[], since: number): { produced: service.ProducedFile[]; missing: string[] } {
	const produced: service.ProducedFile[] = [];
	const missing: string[] = [];
	for (const path of paths) {
		if (pathEscapesWorkspace(path, root)) {
			missing.push(path);
			continue;
		}
		try {
			const found = statSync(resolve(root, path));
			if (found.isFile() && found.mtimeMs >= since) produced.push({ path, bytes: found.size });
			else missing.push(path);
		} catch {
			missing.push(path);
		}
	}
	return { produced, missing };
}

/**
 * The ports a service runs through on this machine, the same for a run and for a run picked up.
 *
 * `say` is where the lines for a person go: standard output, or standard error when a program reads standard
 * output. `interactive` is false for a program, and then nobody at this terminal is asked anything.
 */
function localPorts(root: string, costs: StepCost[], meter: Meter, say: (line: string) => void, interactive: boolean): service.ServicePorts {
	// Settled, not snapshotted: the working turn streams, and its usage arrives in the last chunk.
	const since = async (t: number, u: ModelUsage): Promise<PhaseCost> => {
		const ms = Date.now() - t;
		return { ms, ...usageBetween(u, await meter.settled()) };
	};

	return {
		resolveService: (a) => loadService(root, a),
		async runPersonaStep({ personaRef, prompt, path, position }) {
			const pp = personaPath(root, personaRef);
			if (!existsSync(pp)) return { outcome: "failed", summary: null, reason: `persona ${personaRef} is not installed` };
			say(chalk.dim(`  ${path.join(" > ")} · step ${position} · ${personaRef}`));
			const cost: StepCost = { path, position, persona: personaRef, turn: null, tick: null, tools: { proposed: 0, allowed: 0, asked: 0, denied: [], calls: [] } };
			costs.push(cost);

			const assembled = run.assemble(pp);
			const frontmatter = assembled.handle.frontmatter as Record<string, unknown>;
			const llm = resolveModel({ personaPath: assembled.personaPath, frontmatter });
			if (!llm) return { outcome: "failed", summary: null, reason: `persona ${personaRef} has no model configured` };

			const bus = new EventBus();
			let lastArgs = "";
			bus.on((e: LoopEvent) => {
				if (e.type === "tool-propose") {
					cost.tools.proposed += 1;
					lastArgs = JSON.stringify(e.args).slice(0, 200);
				} else if (e.type === "tool-verdict") {
					// Every verdict with the gate's own reason and what was asked, because "refused"
					// without the why is a number nobody can act on. Found the day every read of a
					// first real run came back refused and the journal could not say why.
					cost.tools.calls.push({ tool: e.tool, args: lastArgs, verdict: e.decision, reason: e.reason });
					if (e.decision === "allow") cost.tools.allowed += 1;
					else if (e.decision === "ask") cost.tools.asked += 1;
					else cost.tools.denied.push(`${e.tool}: ${e.reason}`);
				}
			});

			const presence = holdPresence(pp, { host: "headless", activity: `step ${position} of ${path.join(" > ")}` });
			let t = Date.now();
			let u = await meter.settled();
			let outcome: Awaited<ReturnType<ReturnType<typeof run.runnerFor>["run"]>>;
			try {
				outcome = await run
					.runnerFor(
						{ personaPath: assembled.personaPath, frontmatter, llm },
						{
							policy: { ...policyFromFrontmatter(frontmatter, root), resourceRoots: personaResourceRoots(assembled.personaPath) },
							personaBody: run.identityOf(assembled),
							// E72: the persona's skills are no longer computed here. `runnerFor` offers
							// `use_skill` to every turn of a persona that has skills, and the persona loads
							// the one a step needs, the same way it does in the TUI and over ACP.
							awareness: buildAwarenessBlock(assembled.personaPath, { frontmatter, cwd: root }),
							onApproval: async (call, verdict) => {
								const answer = await approveToolOnTerminal(call.name, String(verdict?.reason ?? ""), interactive);
								if (answer !== "approve" && typeof answer === "object") cost.tools.denied.push(`${call.name}: ${answer.reason}`);
								return answer;
							},
							observer: run.recordingTurns({ personaPath: assembled.personaPath, statePath: assembled.handle.statePath }),
							bus,
						},
					)
					// A program drives this turn, on a definition somebody wrote. `human` would put a
					// person's hand on a turn nobody typed.
					.run({ turn: randomUUID(), prompt, asker: { kind: "component", name: "personaxis-service" } });
			} catch (e) {
				cost.turn = await since(t, u);
				presence.release();
				return { outcome: "failed", summary: null, reason: friendlyProviderError((e as Error).message) };
			}
			cost.turn = await since(t, u);
			presence.release();

			if (outcome.failure) {
				return { outcome: "failed", summary: null, reason: friendlyProviderError(outcome.failure.message) };
			}
			// E84: the persona asked something only a person can answer, and nobody was there. The run waits
			// with the question as its reason, the way it waits for a sub-service that needs a person, instead
			// of handing the next step a question as if it were the delivery. E97: the question itself goes
			// with it, so whoever picks the run up can answer it and the step can read the answer.
			const waiting = waitingForAnswer(outcome.questions);
			const pending = (outcome.questions ?? []).find((asked) => asked.answer === undefined);
			if (waiting !== null && pending !== undefined) {
				const question = { question: pending.question, options: pending.options, ...(pending.recommended === undefined ? {} : { recommended: pending.recommended }) };
				return { outcome: "failed", summary: null, reason: waiting, waitingOnPerson: true, question };
			}
			const ended = stepOutcomeOf(outcome.stopReason, outcome.answer);
			if (ended.outcome === "failed") return { outcome: "failed", summary: null, reason: ended.reason };

			// The governed tick, on what the step put in front of the persona. Not on its own
			// answer: the REPL observes the person's line and not the reply, for the same reason.
			// A persona that appraised its own output would be reacting to itself.
			//
			// Labelled `internal`, not `user`. The prompt can carry third-party text (a
			// contributor's diff, a counterparty's contract) and other personas' notes, and
			// `provenance.ts` says the weakest link wins. Under `user`, an instruction injected
			// into a diff would have justified a self-edit with the trust of the persona's owner.
			t = Date.now();
			u = await meter.settled();
			const tick = await runObserve(pp, prompt, "internal");
			cost.tick = await since(t, u);
			if (!tick.ok) say(chalk.yellow(`    tick failed: ${tick.error}`));

			return { outcome: "completed", summary: outcome.answer, reason: ended.reason };
		},
		approve: (input) => approveOnTerminal(input, interactive),
		checkProduced: async ({ paths, since: from }) => producedIn(root, paths, from),
	};
}

/** What a run leaves next to the work. A run picked up names the run it continued, and what it was given. */
interface Journal {
	service: string;
	started: string;
	wallMs: number;
	brief: string | null;
	/** E97: the journal of the waiting run this one picked up. */
	resumedFrom?: string;
	/** E97: what it was picked up with, as given. */
	reply?: service.ResumeReply;
	/** E97: written on a waiting run when it is picked up, naming the run that continues it. */
	resumedBy?: string;
	result: service.ServiceRunResult;
	/** What this run's own steps cost. A run picked up counts only what it ran; the rest is in `resumedFrom`. */
	costs: StepCost[];
	total: { turn: PhaseCost; tick: PhaseCost };
}

function journalPath(root: string, address: string, started: number): string {
	const runsDir = join(root, SERVICES_DIR, "runs");
	mkdirSync(runsDir, { recursive: true });
	return join(runsDir, `${address}-${new Date(started).toISOString().replace(/[:.]/g, "-")}.json`);
}

/**
 * E97: what can be picked up, read from a journal before anything runs. Exported for its test.
 *
 * A journal already picked up names the run that continued it and is refused: picking the same wait up twice
 * would run the same steps twice and leave two records of one delivery.
 */
export function resumable(journal: unknown): { ok: true; journal: Journal } | { ok: false; why: string } {
	const j = journal as Partial<Journal> | null;
	if (j === null || typeof j !== "object" || typeof j.service !== "string" || j.result === null || typeof j.result !== "object") {
		return { ok: false, why: "this file is not the journal of a service run" };
	}
	if (typeof j.resumedBy === "string") return { ok: false, why: `this run was already picked up, and the run that continued it is ${j.resumedBy}` };
	if (j.result.status !== "waiting") return { ok: false, why: `only a waiting run is picked up, and this one is ${String(j.result.status)}` };
	return { ok: true, journal: j as Journal };
}

/** E97: what `service resume` was told, from its flags. Exported for its test. */
export function replyFrom(opts: { answer?: string; approve?: boolean; reject?: string | boolean }): service.ResumeReply | string {
	const given = [opts.answer !== undefined, opts.approve === true, opts.reject !== undefined && opts.reject !== false].filter(Boolean).length;
	if (given !== 1) return "give exactly one of --answer, --approve or --reject";
	if (opts.answer !== undefined) return { kind: "answer", answer: opts.answer };
	if (opts.approve === true) return { kind: "approval", approved: true };
	const reason = typeof opts.reject === "string" ? opts.reject.trim() : "";
	return { kind: "approval", approved: false, reason: reason.length > 0 ? reason : null };
}

/** The command that picks a waiting run up, as a person would type it. */
function resumeHint(waiting: service.WaitingOn, journal: string): string {
	const where = JSON.stringify(journal);
	return waiting.kind === "answer"
		? `personaxis service resume ${where} --answer "<your answer, or the number of an option>"`
		: `personaxis service resume ${where} --approve   (or --reject "<why>")`;
}

/** A refusal, for a person in words on standard error, for a program as one JSON object on standard output. */
function refuse(json: boolean, code: number, message: string, problems: readonly string[] = []): void {
	process.exitCode = code;
	if (json) {
		console.log(JSON.stringify({ error: message, ...(problems.length > 0 ? { problems } : {}) }));
		return;
	}
	console.error(chalk.red("✗"), message);
	for (const p of problems) console.error(`  - ${p}`);
}

/** Writes the journal, then says how the run ended: to a person in lines, to a program as one JSON object. */
function report(out: string, journal: Journal, json: boolean): void {
	writeFileSync(out, JSON.stringify(journal, null, 1));
	const { result } = journal;
	if (result.status !== "completed") process.exitCode = 1;
	if (json) {
		console.log(
			JSON.stringify({
				service: journal.service,
				status: result.status,
				reason: result.reason,
				summary: result.summary,
				waiting: result.waiting ?? null,
				journal: resolve(out),
				...(journal.resumedFrom === undefined ? {} : { resumedFrom: journal.resumedFrom }),
			}),
		);
		return;
	}

	const tools = journal.costs.reduce((n, c) => ({ proposed: n.proposed + c.tools.proposed, denied: n.denied + c.tools.denied.length }), { proposed: 0, denied: 0 });
	const mark = result.status === "completed" ? chalk.green("✓") : result.status === "waiting" ? chalk.yellow("…") : chalk.red("✗");
	console.log(`${mark} ${journal.service} ${result.status}${result.reason ? `: ${result.reason}` : ""}`);
	// The run's reason is the line's ("step 1 failed"); the step that failed says why. The first
	// one in the record, because a sub-service's steps are recorded before the step that ran it.
	const failedStep = result.steps.find((s) => s.outcome === "failed" && s.reason);
	if (result.status === "failed" && failedStep) {
		console.log(chalk.red(`  ${failedStep.path.join(" > ")} · step ${failedStep.position}: ${failedStep.reason}`));
	}
	for (const step of result.steps) {
		for (const file of step.produced ?? []) {
			console.log(chalk.dim(`  wrote ${file.path} (${file.bytes} bytes) · ${step.path.join(" > ")} · step ${step.position}`));
		}
	}
	if (result.waiting) console.log(chalk.yellow(`  pick it up: ${resumeHint(result.waiting, resolve(out))}`));
	console.log(chalk.dim(`  ${result.steps.length} step(s), ${Math.round(journal.wallMs / 1000)} s · journal ${resolve(out)}`));
	console.log(chalk.dim(`  ${describeCost("work", journal.total.turn)} · ${describeCost("governed ticks", journal.total.tick)}`));
	console.log(chalk.dim(`  tools: ${tools.proposed} proposed, ${tools.denied} refused`));
}

const JSON_FLAG_HELP = "Print one JSON object: how the run ended, what it waits for (the question and its options included) and where its journal is. Nobody at this terminal is asked anything";

const runCommand = new Command("run")
	.description("Run a service on this machine, step by step, including steps that are other services")
	.argument("<address>", "The service, as .personaxis/services/<address>.json")
	.option("--check", "Only check the composition (cycles, depth, references, declared files); run nothing")
	.option("--brief <text>", "What the client asked for, in their own words; every step reads it before its own instruction")
	.option("--brief-file <path>", "The same, read from a file, for a brief too long or too awkward for one shell argument")
	.option("--json", JSON_FLAG_HELP)
	.action(async (address: string, opts: { check?: boolean; brief?: string; briefFile?: string; json?: boolean }) => {
		const root = process.cwd();
		const json = opts.json === true;
		const def = loadService(root, address);
		if (!def) {
			refuse(json, 2, `no service ${address} at ${servicePath(root, address)}`);
			return;
		}

		const problems = service.checkComposition(def, (a) => loadService(root, a));
		if (problems.length) {
			refuse(json, 1, `${address} cannot run as written:`, problems);
			return;
		}
		// The request, from the flag or from a file, before anything runs: a brief that cannot be read
		// is a run with the wrong input, and finding that out after the first step has cost a model call.
		let brief: string | null = null;
		if (opts.brief !== undefined && opts.briefFile !== undefined) {
			refuse(json, 2, "give --brief or --brief-file, not both");
			return;
		}
		if (opts.briefFile !== undefined) {
			try {
				brief = service.clientBrief(readFileSync(resolve(root, opts.briefFile), "utf-8"));
			} catch (e) {
				refuse(json, 2, `cannot read the brief at ${opts.briefFile}: ${e instanceof Error ? e.message : String(e)}`);
				return;
			}
		} else if (opts.brief !== undefined) {
			brief = service.clientBrief(opts.brief);
		}

		if (opts.check) {
			if (json) {
				console.log(JSON.stringify({ service: address, composes: true }));
				return;
			}
			console.log(chalk.green("✓"), `${address} composes cleanly`);
			console.log(chalk.dim(`  no cycles, every reference installed, nesting within the limit of ${service.MAX_SERVICE_DEPTH}, declared files inside the folder`));
			return;
		}

		const started = Date.now();
		// What each step cost and what its tools did. The work and the governed tick are timed and
		// counted apart, so the price of governing is its own number. What each step said is
		// already in `result.steps`; repeating it here would store every deliverable twice.
		const costs: StepCost[] = [];
		const meter = meterModelCalls();
		const say = json ? (line: string) => console.error(line) : (line: string) => console.log(line);

		let result: service.ServiceRunResult;
		try {
			result = await service.runService(def, localPorts(root, costs, meter, say, !json), { workingDir: root, brief });
		} finally {
			meter.stop();
		}

		// The brief is in the journal because it is the input: two runs of the same service differ by
		// it, and a record that does not carry it cannot say what was asked.
		const out = journalPath(root, address, started);
		report(out, { service: address, started: new Date(started).toISOString(), wallMs: Date.now() - started, brief, result, costs, total: totalOf(costs) }, json);
	});

const resumeCommand = new Command("resume")
	.description("Pick up a service run that is waiting for an approval or for an answer, from its journal")
	.argument("<journal>", "The waiting run's journal, as .personaxis/services/runs/<address>-<timestamp>.json")
	.option("--answer <text>", "The answer to the question the run waits on; a number or an option's label picks that option")
	.option("--approve", "Approve the step the run waits on, and go on")
	.option("--reject [reason]", "Refuse it: the run ends there, with the reason when one is given")
	.option("--json", JSON_FLAG_HELP)
	.action(async (journalArg: string, opts: { answer?: string; approve?: boolean; reject?: string | boolean; json?: boolean }) => {
		const root = process.cwd();
		const json = opts.json === true;
		const reply = replyFrom(opts);
		if (typeof reply === "string") {
			refuse(json, 2, reply);
			return;
		}

		const from = resolve(root, journalArg);
		let text: string;
		let parsed: unknown;
		try {
			text = readFileSync(from, "utf-8");
			parsed = JSON.parse(text);
		} catch (e) {
			refuse(json, 2, `cannot read the journal at ${journalArg}: ${e instanceof Error ? e.message : String(e)}`);
			return;
		}
		const stored = resumable(parsed);
		if (!stored.ok) {
			refuse(json, 2, stored.why);
			return;
		}
		const address = stored.journal.service;
		const def = loadService(root, address);
		if (!def) {
			refuse(json, 2, `no service ${address} at ${servicePath(root, address)}`);
			return;
		}
		const problems = service.checkComposition(def, (a) => loadService(root, a));
		if (problems.length) {
			refuse(json, 1, `${address} cannot run as written:`, problems);
			return;
		}

		const started = Date.now();
		const out = journalPath(root, address, started);
		const brief = stored.journal.brief ?? null;
		// Marked before anything runs, so the same wait cannot be picked up a second time while this run is on its
		// way. Unmarked when the engine leaves the run alone or throws, because then nothing continued it.
		writeFileSync(from, JSON.stringify({ ...stored.journal, resumedBy: resolve(out) }, null, 1));
		const costs: StepCost[] = [];
		const meter = meterModelCalls();
		const say = json ? (line: string) => console.error(line) : (line: string) => console.log(line);

		let resumed: service.Resumed;
		try {
			resumed = await service.resumeService(def, localPorts(root, costs, meter, say, !json), { result: stored.journal.result, brief, workingDir: root }, reply);
		} catch (e) {
			writeFileSync(from, text);
			throw e;
		} finally {
			meter.stop();
		}
		if (!resumed.resumed) {
			writeFileSync(from, text);
			refuse(json, 2, resumed.why);
			return;
		}

		report(
			out,
			{ service: address, started: new Date(started).toISOString(), wallMs: Date.now() - started, brief, resumedFrom: from, reply, result: resumed.result, costs, total: totalOf(costs) },
			json,
		);
	});

interface PhaseCost extends ModelUsage {
	ms: number;
}

/** One persona step's cost and what its tools did. A phase that never ran is null, not zero. */
interface StepCost {
	path: readonly string[];
	position: number;
	persona: string;
	turn: PhaseCost | null;
	tick: PhaseCost | null;
	tools: {
		proposed: number;
		allowed: number;
		asked: number;
		denied: string[];
		calls: Array<{ tool: string; args: string; verdict: "allow" | "ask" | "deny"; reason: string }>;
	};
}

const NO_COST: PhaseCost = { ms: 0, calls: 0, promptTokens: 0, completionTokens: 0, unreported: 0 };

/** Every step's phases added up. Exported for its test. */
export function totalOf(costs: readonly Pick<StepCost, "turn" | "tick">[]): { turn: PhaseCost; tick: PhaseCost } {
	const add = (a: PhaseCost, b: PhaseCost | null): PhaseCost =>
		b === null
			? a
			: {
					ms: a.ms + b.ms,
					calls: a.calls + b.calls,
					promptTokens: a.promptTokens + b.promptTokens,
					completionTokens: a.completionTokens + b.completionTokens,
					unreported: a.unreported + b.unreported,
				};
	return costs.reduce<{ turn: PhaseCost; tick: PhaseCost }>((sum, c) => ({ turn: add(sum.turn, c.turn), tick: add(sum.tick, c.tick) }), { turn: NO_COST, tick: NO_COST });
}

function describeCost(label: string, c: PhaseCost): string {
	const tokens = `${c.promptTokens + c.completionTokens} tokens`;
	// A call that reported nothing makes the token count a floor, and it says so.
	const floor = c.unreported > 0 ? ` (at least; ${c.unreported} call(s) did not report)` : "";
	return `${label}: ${c.calls} call(s), ${tokens}${floor}, ${Math.round(c.ms / 1000)} s`;
}

export const serviceCommand = new Command("service")
	.description("Services: a repeatable job with steps, done by personas and by other services")
	.addCommand(runCommand)
	.addCommand(resumeCommand);
