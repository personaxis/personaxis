/**
 * E132: an edit that breaks a script's syntax says so in its own result, in the step that broke it.
 *
 * Measured on 2026-09-24 (`e121c`): in two long sessions the persona broke its game with an edit, saw its
 * check fail steps later, named the missing comma correctly, and closed the turn explaining it instead of
 * fixing it. These run the real tools on real files and read the text the model will read, including the
 * negative ones that matter as much: a file that compiles says nothing more, a module is not judged, and a
 * file that is not a script is left alone.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { localExecution } from "../src/ports/execution.js";
import { editFileTool } from "../src/tools/builtin/edit-file.js";
import { writeFileTool } from "../src/tools/builtin/write-file.js";
import { renderPageRun, runPage, syntaxFault } from "../src/web/run-page.js";
import type { Policy } from "../src/sandbox.js";

function workspace(): Policy {
	return { sandbox: "workspace-write", approval: "never", allow: [], deny: [], workspaceRoot: mkdtempSync(join(tmpdir(), "pxs-e132-")) };
}
const execution = localExecution();

const GAME = [
	"<!doctype html>",
	"<canvas id=c></canvas>",
	"<script>",
	"const state = {",
	"  catX: 50,",
	"  catY: 160,",
	"  speed: 2,",
	"};",
	"requestAnimationFrame(function tick() { state.catX += state.speed; requestAnimationFrame(tick); });",
	"</script>",
	"",
].join("\n");

describe("an edit that breaks the syntax says so in its own result (E132)", () => {
	it("edit_file: the missing comma from e121c, at its line in the FILE and quoted", async () => {
		const policy = workspace();
		writeFileSync(join(policy.workspaceRoot, "game.html"), GAME);
		const said = await editFileTool.execute({ path: "game.html", find: "  catY: 160,", replace: "  catY: 160" }, policy, execution);
		expect(said).toMatch(/^edited /);
		expect(said).toContain("does not compile now");
		expect(said).toContain("line 7");
		expect(said).toContain("SyntaxError");
	});

	it("write_file: a script written broken says so", async () => {
		const policy = workspace();
		const said = await writeFileTool.execute({ path: "game.js", content: "const a = {\n  x: 1\n  y: 2\n};\n" }, policy, execution);
		expect(said).toMatch(/^wrote /);
		expect(said).toContain("does not compile now");
		expect(said).toContain("line 3");
	});

	it("the same compiler as check_page: a page that fails to compile there fails here, and one that runs is silent here", () => {
		const broken = GAME.replace("  catY: 160,", "  catY: 160");
		expect(runPage(broken).ok).toBe(false);
		expect(syntaxFault("game.html", broken)).not.toBeNull();
		expect(runPage(GAME).ok).toBe(true);
		expect(syntaxFault("game.html", GAME)).toBeNull();
		// And they cite the same line, so the two tools never disagree about where it broke.
		expect(renderPageRun("game.html", runPage(broken), 1)).toContain("line 7");
	});
});

describe("and says nothing it cannot back (E132)", () => {
	it("an edit that leaves the file compiling adds nothing", async () => {
		const policy = workspace();
		writeFileSync(join(policy.workspaceRoot, "game.html"), GAME);
		const said = await editFileTool.execute({ path: "game.html", find: "  speed: 2,", replace: "  speed: 3," }, policy, execution);
		expect(said).not.toContain("compile");
	});

	it("a module is not judged, because this compiler reads classic scripts", () => {
		expect(syntaxFault("app.js", "import { x } from './x.js';\nexport const y = x + ;\n")).toBeNull();
	});

	it("a file that is not a script is left alone", async () => {
		const policy = workspace();
		const said = await writeFileTool.execute({ path: "notes.md", content: "const a = {\n  x: 1\n  y: 2\n" }, policy, execution);
		expect(said).not.toContain("compile");
	});
});
