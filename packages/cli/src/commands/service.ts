/**
 * `personaxis service`, running a service on this machine, including services that contain services.
 *
 * This file wires things that already exist and invents none of them. The decision about what runs
 * next is `service.runService` in the engine, which sits on `advance` and `handoverText` moved from
 * the SaaS unchanged. A persona step is the same governed reply `personaxis -p` gives, followed by
 * the same governed tick the daemon runs through `runObserve`, so the persona's state moves across
 * the service and recompiles when a band is crossed. That second half is what makes a step a
 * persona at work rather than a document pasted into a prompt.
 *
 * A service is a JSON file in `.personaxis/services/<address>.json`, in the shape of the SaaS's
 * `ServiceTemplate`, plus `serviceRef` for a step done by another service. The run's journal is
 * written next to the work, which is where the durable-execution ADR puts it.
 *
 * What this does NOT do yet, said so it is not assumed: a step answers in text, and does not call
 * tools. Tool calls through the gate are the next piece, and until then the gate is not exercised
 * here even though the persona's state and record are.
 */

import { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import { service } from "@personaxis/core";

import { governedReply } from "../repl/headless.js";
import { recordTurn } from "../repl/session.js";
import { meterModelCalls, usageBetween, type ModelUsage } from "../usage-meter.js";
import { runObserve } from "./observe.js";

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

/** Ask a person on the terminal, or say nobody can answer. Never answers for them. */
async function approveOnTerminal(input: { serviceName: string; position: number }): Promise<"approved" | "rejected" | "unavailable"> {
	if (!process.stdin.isTTY) return "unavailable";
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const answer = (await rl.question(chalk.yellow(`  approve step ${input.position} of ${input.serviceName}? [y/N] `))).trim().toLowerCase();
	rl.close();
	return answer === "y" || answer === "yes" ? "approved" : "rejected";
}

const runCommand = new Command("run")
	.description("Run a service on this machine, step by step, including steps that are other services")
	.argument("<address>", "The service, as .personaxis/services/<address>.json")
	.option("--check", "Only check the composition (cycles, depth, references); run nothing")
	.action(async (address: string, opts: { check?: boolean }) => {
		const root = process.cwd();
		const def = loadService(root, address);
		if (!def) {
			console.error(chalk.red("✗"), `no service ${address} at ${servicePath(root, address)}`);
			process.exitCode = 2;
			return;
		}

		const problems = service.checkComposition(def, (a) => loadService(root, a));
		if (problems.length) {
			console.error(chalk.red("✗"), `${address} cannot run as written:`);
			for (const p of problems) console.error(`  - ${p}`);
			process.exitCode = 1;
			return;
		}
		if (opts.check) {
			console.log(chalk.green("✓"), `${address} composes cleanly`);
			console.log(chalk.dim(`  no cycles, every reference installed, nesting within the limit of ${service.MAX_SERVICE_DEPTH}`));
			return;
		}

		const started = Date.now();
		// What each step cost, in time and in model calls, split into the answer, the bookkeeping
		// and the governed tick, so the price of governing is its own number. What each step said
		// is already in `result.steps`; repeating it here would store every deliverable twice.
		const costs: StepCost[] = [];
		const meter = meterModelCalls();
		const since = (t: number, u: ModelUsage): PhaseCost => ({ ms: Date.now() - t, ...usageBetween(u, meter.snapshot()) });

		const ports: service.ServicePorts = {
			resolveService: (a) => loadService(root, a),
			async runPersonaStep({ personaRef, prompt, path, position }) {
				const pp = personaPath(root, personaRef);
				if (!existsSync(pp)) return { outcome: "failed", summary: null, reason: `persona ${personaRef} is not installed` };
				console.log(chalk.dim(`  ${path.join(" > ")} · step ${position} · ${personaRef}`));
				const cost: StepCost = { path, position, persona: personaRef, reply: null, record: null, tick: null };
				costs.push(cost);

				// The same reply `personaxis -p` gives, from the same function, so a persona answers a
				// step exactly as it answers when called directly.
				let reply: string;
				let ctx: Awaited<ReturnType<typeof governedReply>>["ctx"];
				let t = Date.now();
				let u = meter.snapshot();
				try {
					({ reply, ctx } = await governedReply({
						personaPath: pp,
						prompt,
						activity: `step ${position} of ${path.join(" > ")}`,
						onResponderError: "throw",
					}));
				} catch (e) {
					cost.reply = since(t, u);
					return { outcome: "failed", summary: null, reason: (e as Error).message };
				}
				cost.reply = since(t, u);

				// Naming a new session can call the model, which is why it is counted apart.
				t = Date.now();
				u = meter.snapshot();
				await recordTurn(ctx, prompt, reply, "background");
				cost.record = since(t, u);

				// The governed tick. Without it a step is the document plus a prompt, and the
				// persona would not change across the service no matter what it met.
				//
				// Labelled `internal`, not `user`. The observation is the step's prompt, which can
				// carry third-party text (a contributor's diff, a counterparty's contract), plus
				// other personas' notes and this persona's own reply. `provenance.ts` says the
				// weakest link wins, and under `user` an instruction injected into a diff would have
				// justified a self-edit with the trust of the persona's owner.
				t = Date.now();
				u = meter.snapshot();
				const tick = await runObserve(pp, `${prompt}\n\n${reply}`, "internal");
				cost.tick = since(t, u);
				if (!tick.ok) console.log(chalk.yellow(`    tick failed: ${tick.error}`));

				return { outcome: "completed", summary: reply };
			},
			approve: approveOnTerminal,
		};

		let result: service.ServiceRunResult;
		try {
			result = await service.runService(def, ports, { workingDir: root });
		} finally {
			meter.stop();
		}

		const total = totalOf(costs);
		const runsDir = join(root, SERVICES_DIR, "runs");
		mkdirSync(runsDir, { recursive: true });
		const out = join(runsDir, `${address}-${new Date(started).toISOString().replace(/[:.]/g, "-")}.json`);
		writeFileSync(out, JSON.stringify({ service: address, started: new Date(started).toISOString(), wallMs: Date.now() - started, result, costs, total }, null, 1));

		const mark = result.status === "completed" ? chalk.green("✓") : result.status === "waiting" ? chalk.yellow("…") : chalk.red("✗");
		console.log(`${mark} ${address} ${result.status}${result.reason ? `: ${result.reason}` : ""}`);
		console.log(chalk.dim(`  ${result.steps.length} step(s), ${Math.round((Date.now() - started) / 1000)} s · journal ${resolve(out)}`));
		console.log(chalk.dim(`  ${describeCost("answers", total.reply)} · ${describeCost("governed ticks", total.tick)} · ${describeCost("bookkeeping", total.record)}`));
		if (result.status !== "completed") process.exitCode = 1;
	});

interface PhaseCost extends ModelUsage {
	ms: number;
}

/** One persona step's cost. A phase that never ran is null, not zero. */
interface StepCost {
	path: readonly string[];
	position: number;
	persona: string;
	reply: PhaseCost | null;
	record: PhaseCost | null;
	tick: PhaseCost | null;
}

const NO_COST: PhaseCost = { ms: 0, calls: 0, promptTokens: 0, completionTokens: 0, unreported: 0 };

/** Every step's phases added up. Exported for its test. */
export function totalOf(costs: readonly StepCost[]): { reply: PhaseCost; record: PhaseCost; tick: PhaseCost } {
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
	return costs.reduce(
		(sum, c) => ({ reply: add(sum.reply, c.reply), record: add(sum.record, c.record), tick: add(sum.tick, c.tick) }),
		{ reply: NO_COST, record: NO_COST, tick: NO_COST },
	);
}

function describeCost(label: string, c: PhaseCost): string {
	const tokens = `${c.promptTokens + c.completionTokens} tokens`;
	// A call that reported nothing makes the token count a floor, and it says so.
	const floor = c.unreported > 0 ? ` (at least; ${c.unreported} call(s) did not report)` : "";
	return `${label}: ${c.calls} call(s), ${tokens}${floor}, ${Math.round(c.ms / 1000)} s`;
}

export const serviceCommand = new Command("service")
	.description("Services: a repeatable job with steps, done by personas and by other services")
	.addCommand(runCommand);
