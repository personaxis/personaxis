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
		// Only the time per step. What each step said is already in `result.steps`; repeating it
		// here would store every deliverable twice in the same file.
		const timings: Array<{ path: readonly string[]; position: number; persona: string; ms: number }> = [];

		const ports: service.ServicePorts = {
			resolveService: (a) => loadService(root, a),
			async runPersonaStep({ personaRef, prompt, path, position }) {
				const pp = personaPath(root, personaRef);
				if (!existsSync(pp)) return { outcome: "failed", summary: null, reason: `persona ${personaRef} is not installed` };
				const t0 = Date.now();
				console.log(chalk.dim(`  ${path.join(" > ")} · step ${position} · ${personaRef}`));

				// The same reply `personaxis -p` gives, from the same function, so a persona answers a
				// step exactly as it answers when called directly.
				let reply: string;
				let ctx: Awaited<ReturnType<typeof governedReply>>["ctx"];
				try {
					({ reply, ctx } = await governedReply({
						personaPath: pp,
						prompt,
						activity: `step ${position} of ${path.join(" > ")}`,
						onResponderError: "throw",
					}));
				} catch (e) {
					timings.push({ path, position, persona: personaRef, ms: Date.now() - t0 });
					return { outcome: "failed", summary: null, reason: (e as Error).message };
				}
				await recordTurn(ctx, prompt, reply, "background");

				// The governed tick. Without it a step is the document plus a prompt, and the
				// persona would not change across the service no matter what it met.
				const tick = await runObserve(pp, `${prompt}\n\n${reply}`, "user");
				if (!tick.ok) console.log(chalk.yellow(`    tick failed: ${tick.error}`));

				timings.push({ path, position, persona: personaRef, ms: Date.now() - t0 });
				return { outcome: "completed", summary: reply };
			},
			approve: approveOnTerminal,
		};

		const result = await service.runService(def, ports, { workingDir: root });

		const runsDir = join(root, SERVICES_DIR, "runs");
		mkdirSync(runsDir, { recursive: true });
		const out = join(runsDir, `${address}-${new Date(started).toISOString().replace(/[:.]/g, "-")}.json`);
		writeFileSync(out, JSON.stringify({ service: address, started: new Date(started).toISOString(), wallMs: Date.now() - started, result, timings }, null, 1));

		const mark = result.status === "completed" ? chalk.green("✓") : result.status === "waiting" ? chalk.yellow("…") : chalk.red("✗");
		console.log(`${mark} ${address} ${result.status}${result.reason ? `: ${result.reason}` : ""}`);
		console.log(chalk.dim(`  ${result.steps.length} step(s), ${Math.round((Date.now() - started) / 1000)} s · journal ${resolve(out)}`));
		if (result.status !== "completed") process.exitCode = 1;
	});

export const serviceCommand = new Command("service")
	.description("Services: a repeatable job with steps, done by personas and by other services")
	.addCommand(runCommand);
