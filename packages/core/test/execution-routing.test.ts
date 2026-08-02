/**
 * F2: an allowed action happens where the port says, not where the process is.
 *
 * The contract test next door proves the ports agree on shapes. This proves the engine
 * actually goes through one, which is a different claim and the one that breaks silently:
 * a tool reaching for `spawn` itself still passes every shape test, and runs on whatever
 * machine hosts the process. For a hosted job that is the wrong machine, and it fails by
 * working, which is the only failure mode nobody reports.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolInterceptor } from "../src/security/interceptor.js";
import { ForensicLog } from "../src/security/forensic-log.js";
import { toolByName } from "../src/tools/registry.js";
import { localExecution, noExecution, type ExecutionPort } from "../src/ports/execution.js";
import type { Policy } from "../src/sandbox.js";
import type { ExecResult, FileResult } from "../src/tools/exec.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pxs-routing-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function policy(): Policy {
	return { sandbox: "workspace-write", approval: "never", allow: [], deny: [], workspaceRoot: root };
}

/** A port that records what it was asked to do and touches nothing. */
function recordingPort(): ExecutionPort & { calls: string[] } {
	const calls: string[] = [];
	const file = (path: string): FileResult => ({ ok: true, path, content: "from the port" });
	const exec: ExecResult = {
		ok: true,
		code: 0,
		stdout: "from the port",
		stderr: "",
		truncated: false,
		timedOut: false,
	};

	return {
		calls,
		location: "hosted",
		describe: "a recording port",
		async runCommand(cmd) {
			calls.push(`run:${cmd}`);
			return exec;
		},
		async writeFile(path) {
			calls.push(`write:${path}`);
			return file(path);
		},
		async editFile(path) {
			calls.push(`edit:${path}`);
			return file(path);
		},
		async readFile(path) {
			calls.push(`read:${path}`);
			return file(path);
		},
		async listDir(path) {
			calls.push(`list:${path}`);
			return file(path);
		},
	};
}

function interceptor(execution: ExecutionPort): ToolInterceptor {
	return new ToolInterceptor(policy(), new ForensicLog(), undefined, null, execution);
}

describe("the interceptor acts through the port it was given", () => {
	it("routes a command to the port instead of spawning", async () => {
		const port = recordingPort();
		const outcome = await interceptor(port).run(toolByName("run_command")!, {
			id: "1",
			name: "run_command",
			args: { command: "echo hello" },
		});

		expect(port.calls).toEqual(["run:echo hello"]);
		expect(outcome.output).toContain("from the port");
	});

	it("routes a write to the port, and the local filesystem stays untouched", async () => {
		// This is the assertion that matters: a hosted job writing to the host's disk is
		// data leaving the sandbox it was supposed to stay in, and nothing fails.
		const port = recordingPort();
		await interceptor(port).run(toolByName("write_file")!, {
			id: "1",
			name: "write_file",
			args: { path: "should-not-be-here.txt", content: "x" },
		});

		expect(port.calls).toEqual(["write:should-not-be-here.txt"]);
		expect(existsSync(join(root, "should-not-be-here.txt"))).toBe(false);
	});

	it("routes reads and listings too, so nothing has a private path to the disk", async () => {
		const port = recordingPort();
		const via = interceptor(port);

		await via.run(toolByName("read_file")!, { id: "1", name: "read_file", args: { path: "a.txt" } });
		await via.run(toolByName("list_dir")!, { id: "2", name: "list_dir", args: { path: "." } });

		expect(port.calls).toEqual(["read:a.txt", "list:."]);
	});

	it("defaults to this machine when nobody says otherwise", async () => {
		// Every existing caller means the local machine, and they must keep working. The
		// default lives in ONE place so a per-tool fallback cannot reintroduce the bug the
		// test above rules out.
		await interceptor(localExecution()).run(toolByName("write_file")!, {
			id: "1",
			name: "write_file",
			args: { path: "written.txt", content: "local" },
		});

		expect(existsSync(join(root, "written.txt"))).toBe(true);
	});

	it("reports a refusal from a port with nowhere to run, without dying", async () => {
		// A hosted job whose sandbox never came up gets a failed step it can react to,
		// rather than an exception that ends the run before anything is recorded.
		const outcome = await interceptor(noExecution("the sandbox failed to start")).run(
			toolByName("run_command")!,
			{ id: "1", name: "run_command", args: { command: "ls" } },
		);

		expect(outcome.output).toContain("the sandbox failed to start");
		expect(existsSync(join(root, "anything"))).toBe(false);
	});
});
