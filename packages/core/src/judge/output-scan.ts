/**
 * E159: a classifier reads every tool output while the model is thinking, and what it finds raises the context's
 * taint before the next tool call is decided.
 *
 * ## Why it can run beside the model
 *
 * The taint of the context is read in one place only: when the next tool call is decided, by the consent matrix in
 * `security/consent.ts`. Between a tool output and that decision there is always a model call, which is remote and
 * leaves this machine's CPU idle. So a classification starts the moment an output arrives and is awaited only by the
 * next decision. Measured on 2026-10-01 for `E153`, which awaited it in line and retired on it: 1,450 ms on average per
 * real bench output on CPU, because a file is read whole, in windows of 512 tokens.
 *
 * ## What it changes and what it does not
 *
 * A score above `SUSPICIOUS_AT` raises the taint to `suspicious`, which makes the consent matrix ASK before any later
 * call; a score of `MALICIOUS_AT` or more raises it to `malicious`, which also denies destructive, network and
 * out-of-workspace calls. It never blocks by itself, never rewrites the output, and never lowers a taint the
 * heuristic scanner already raised. Every score goes into the record as a judgement in `act` mode, so the runs where
 * it raised the taint can be counted against the bench's checker.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { ContextTaint } from "../security/consent.js";
import type { Judgement } from "./judge.js";
import { paxProcess, type PaxProcess } from "./pax-process.js";

/** A model that scores how likely a text is to carry an injected instruction. */
export interface OutputClassifier {
	/** Model, revision and variant, written into every judgement. */
	readonly engine: string;
	classify(text: string): Promise<{ readonly p: number }>;
}

/**
 * Wolf Defender fp16 run from Node: the score that 1% of InjecAgent's 510 clean texts exceed, measured on 2026-10-01
 * by running the ONNX export from Node over InjecAgent's attacks and clean texts. At it, 345 of 510 attacks are above,
 * and 20 of 3,706 clean bench outputs. Belongs to that engine: a different model or variant needs its own measurement.
 */
const SUSPICIOUS_AT = 8.377e-4;
/** At 0.5, 219 of 510 attacks and none of the 510 clean texts, nor any of the 3,706 bench outputs. */
const MALICIOUS_AT = 0.5;

/** The taint one score implies. */
function taintOf(p: number): ContextTaint {
	if (p >= MALICIOUS_AT) return "malicious";
	if (p > SUSPICIOUS_AT) return "suspicious";
	return "clean";
}

const RANK: Record<ContextTaint, number> = { clean: 0, suspicious: 1, malicious: 2 };

/**
 * The scans of one run. `start` begins one and returns at once; `taint` waits for every scan started since the last
 * call and returns the highest taint they imply; `settle` waits for all of them and hands back the judgements.
 *
 * The scans run one after another on a chain, not side by side: one ONNX session, and a second scan would only take
 * the cores from the first.
 */
export class OutputScans {
	private chain: Promise<unknown> = Promise.resolve();
	private pending: Promise<ContextTaint>[] = [];
	private readonly judgements: Judgement[] = [];

	/** `load` is called once, on the first output, so a run with no classifier configured loads nothing. */
	constructor(private readonly load?: () => Promise<OutputClassifier | undefined>) {}

	private classifier?: Promise<OutputClassifier | undefined>;

	start(text: string): void {
		if (!this.load || !text.trim()) return;
		this.classifier ??= this.load();
		const loading = this.classifier;
		const scan = this.chain.then(async (): Promise<ContextTaint> => {
			const classifier = await loading;
			if (!classifier) return "clean";
			const started = performance.now();
			try {
				const { p } = await classifier.classify(text);
				this.judgements.push({ site: "tool-output", question: "injection", engine: classifier.engine, answer: { kind: "noul", p }, ms: Math.round(performance.now() - started), mode: "act" });
				return taintOf(p);
			} catch (error) {
				process.stderr.write(`[judge] ${classifier.engine} failed on a tool output: ${error instanceof Error ? error.message : String(error)}\n`);
				return "clean";
			}
		});
		this.chain = scan;
		this.pending.push(scan);
	}

	async taint(): Promise<ContextTaint> {
		const waiting = this.pending;
		this.pending = [];
		let worst: ContextTaint = "clean";
		for (const taint of await Promise.all(waiting)) if (RANK[taint] > RANK[worst]) worst = taint;
		return worst;
	}

	async settle(): Promise<readonly Judgement[]> {
		await this.taint();
		return [...this.judgements];
	}
}

/**
 * Wolf Defender fp16 in Pax's own process (`pax-process.ts`). The engine name is the one that process reports; before
 * the first score it is plain `wolf-defender`, and no judgement is written before a score.
 */
function paxWolf(pax: PaxProcess): OutputClassifier {
	let engine = "wolf-defender";
	return {
		get engine() {
			return engine;
		},
		async classify(text) {
			const reply = await pax.request({ op: "classify", text });
			if (!reply.ok) throw new Error(reply.error);
			engine = reply.engine;
			if (typeof reply.p !== "number") throw new Error("Pax's process answered without a score");
			return { p: reply.p };
		},
	};
}

/**
 * Wolf from `PERSONAXIS_PAX_DIR`, when the fp16 model is there and `PERSONAXIS_WOLF` is not `off`. The switch exists so
 * a measurement can keep the turn-start judge of `E157` on in both arms and compare only this. A Wolf that fails to
 * load fails at its first score, which `OutputScans` turns into a line on stderr and no judgement.
 */
export function wolfFromEnv(): Promise<OutputClassifier | undefined> {
	const dir = process.env.PERSONAXIS_PAX_DIR;
	if (!dir || process.env.PERSONAXIS_WOLF === "off" || !existsSync(join(dir, "models", "wolf", "model-fp16.onnx"))) return Promise.resolve(undefined);
	const pax = paxProcess();
	return Promise.resolve(pax === undefined ? undefined : paxWolf(pax));
}
