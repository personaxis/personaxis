/**
 * E85: what a turn left, what follows from it, and when a zero exit code proves anything.
 *
 * The three pure pieces the loop leans on. Each rule here comes from the note `trabajar-sin-nadie-delante`
 * (2026-08-22), which measured them in a repository that had already been wrong about them: a pipeline's zero
 * was read as a passing suite, a targeted check was promoted to "the repository is green", and evidence stayed
 * valid after the file under it had changed.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deliveredBy, deliveredIn } from "../src/run/delivered.js";
import { runDerivedChecks } from "../src/run/derived-checks.js";
import { exitCodeAttributes, type Policy } from "../src/sandbox.js";

let workspace: string;

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "pxs-e85-"));
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
});

const policy = (): Policy => ({ sandbox: "workspace-write", approval: "on-failure", allow: [], deny: [], workspaceRoot: workspace });

describe("when a zero exit code attributes (E85)", () => {
	it("attributes to a single command, and to a chain that is all conjunctions", () => {
		expect(exitCodeAttributes("npm test").attributes).toBe(true);
		expect(exitCodeAttributes("  pnpm build  ").attributes).toBe(true);
		expect(exitCodeAttributes("npm run lint && npm test && npm run build").attributes).toBe(true);
	});

	it("does not attribute through a pipeline, which reports its last stage", () => {
		const read = exitCodeAttributes("npm test | tee test.log");
		expect(read.attributes).toBe(false);
		expect(read.why).toContain("last stage");
	});

	it("does not attribute through a disjunction, which runs the right side when the left failed", () => {
		expect(exitCodeAttributes("npm test || echo 'never mind'").attributes).toBe(false);
	});

	it("does not attribute to a backgrounded job, which returns the shell's code", () => {
		expect(exitCodeAttributes("npm test &").attributes).toBe(false);
	});

	it("does not attribute through an unconditional chain, where only the last command is reported", () => {
		expect(exitCodeAttributes("npm test; echo done").attributes).toBe(false);
		expect(exitCodeAttributes("npm test\necho done").attributes).toBe(false);
	});

	it("reads an operator inside quotes as text, because it is text", () => {
		expect(exitCodeAttributes(`echo "a && b"`).attributes).toBe(true);
		expect(exitCodeAttributes(`node -e "process.exit(0) || 1"`).attributes).toBe(true);
	});

	it("says there is nothing to attribute to when there is no command", () => {
		expect(exitCodeAttributes("   ").attributes).toBe(false);
	});
});

describe("what a turn left (E85)", () => {
	it("counts a write and an edit, and nothing else", () => {
		const args = { path: "game.html", content: "x" };
		expect(deliveredBy({ tool: "write_file", args, policy: policy(), at: 10 })?.path).toContain("game.html");
		expect(deliveredBy({ tool: "edit_file", args: { path: "GAME.md" }, policy: policy(), at: 10 })?.path).toContain("GAME.md");
		expect(deliveredBy({ tool: "read_file", args, policy: policy(), at: 10 })).toBeUndefined();
		expect(deliveredBy({ tool: "run_command", args: { command: "node build.js" }, policy: policy(), at: 10 })).toBeUndefined();
		expect(deliveredBy({ tool: "write_file", args: {}, policy: policy(), at: 10 })).toBeUndefined();
	});

	it("keeps one entry per file, the last write of it", () => {
		const left = deliveredIn([
			{ path: "/w/game.html", at: 10 },
			{ path: "/w/GAME.md", at: 11 },
			{ path: "/w/game.html", at: 30 },
		]);
		expect(left).toHaveLength(2);
		expect(left.find((d) => d.path === "/w/game.html")?.at).toBe(30);
	});

	it("keeps the version that survived the turn, which is what any check is about", () => {
		// Inside one turn this is the whole of the note's staleness rule: the checks run after the last write,
		// so what is checked is what is on disk at the end. Across turns it belongs to whoever reads the
		// evidence back out of the record, and nothing does that yet.
		const left = deliveredIn([
			{ path: "/w/game.html", at: 10 },
			{ path: "/w/game.html", at: 30 },
		]);
		expect(left).toEqual([{ path: "/w/game.html", at: 30 }]);
	});
});

describe("the check a deliverable carries (E85)", () => {
	it("runs a page, and fails the one that dies part way through", () => {
		const good = join(workspace, "runs.html");
		const bad = join(workspace, "crashes.html");
		writeFileSync(good, "<html><body><script>let n = 0; function tick(){ n += 1; } tick();</script></body></html>");
		// The fault these checks exist for: fine at load, dead once the clock has moved.
		writeFileSync(bad, "<html><body><script>let f = 0; setInterval(() => { f += 1; if (f > 2) missing(); }, 16);</script></body></html>");

		const result = runDerivedChecks([good, bad]);
		expect(result.unverified).toEqual([]);
		expect(result.checks.find((c) => c.what === good)?.passed).toBe(true);
		const failed = result.checks.find((c) => c.what === bad);
		expect(failed?.passed).toBe(false);
		expect(failed?.reason).toBeTruthy();
	});

	it("parses a JSON file, and says what is wrong with one that does not parse", () => {
		const good = join(workspace, "data.json");
		const bad = join(workspace, "broken.json");
		writeFileSync(good, '{"a": 1}');
		writeFileSync(bad, "{a: 1,}");

		const result = runDerivedChecks([good, bad]);
		expect(result.checks.find((c) => c.what === good)).toMatchObject({ passed: true, how: "parsed it as JSON", scope: "targeted" });
		expect(result.checks.find((c) => c.what === bad)?.passed).toBe(false);
	});

	it("names what it cannot check instead of passing it, because an unnamed absence reads as verified", () => {
		const doc = join(workspace, "GAME.md");
		writeFileSync(doc, "# A document");

		const result = runDerivedChecks([doc]);
		expect(result.checks).toEqual([]);
		expect(result.unverified).toEqual([doc]);
	});

	it("fails a deliverable that cannot be opened, because it was written during this turn", () => {
		const gone = join(workspace, "vanished.html");
		const result = runDerivedChecks([gone]);
		expect(result.checks[0]).toMatchObject({ what: gone, passed: false, how: "opened it" });
	});

	it("keeps every check targeted, so nothing climbs to a claim about the workspace", () => {
		const page = join(workspace, "p.html");
		writeFileSync(page, "<html><body><script>1</script></body></html>");
		for (const check of runDerivedChecks([page]).checks) expect(check.scope).toBe("targeted");
	});
});
