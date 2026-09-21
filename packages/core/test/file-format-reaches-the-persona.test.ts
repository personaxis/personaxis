/**
 * `E102`: the warning is worth nothing unless the persona actually reads it.
 *
 * `file-format.test.ts` holds the rule. This holds the wiring, and the two are separate on purpose: a
 * function that returns the right string and a tool that never calls it look identical from the rule's side.
 * `check_page` spent four days defined and not offered, which is the same shape of mistake one layer up.
 *
 * So these run the real tools, against a real temporary workspace, and read what comes back the way the
 * persona reads it: as the one line the runtime hands to the model after the call.
 */

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { localExecution } from "../src/ports/execution.js";
import { editFileTool } from "../src/tools/builtin/edit-file.js";
import { writeFileTool } from "../src/tools/builtin/write-file.js";
import type { Policy } from "../src/sandbox.js";

function workspace(): Policy {
  return {
    sandbox: "workspace-write",
    approval: "never",
    allow: [],
    deny: [],
    workspaceRoot: mkdtempSync(join(tmpdir(), "pxs-e102-")),
  };
}

const execution = localExecution();

describe("what comes back after writing a file whose name promises a format", () => {
  it("write_file says the file was written AND that the name is wrong", async () => {
    const policy = workspace();

    const said = await writeFileTool.execute(
      { path: "pitch.pdf", content: "Frog Catcher\n\nA game about catching flies.\n" },
      policy,
      execution,
    );

    // Both halves matter. Dropping the first would turn a successful write into what reads like a failure.
    expect(said).toContain("bytes to");
    expect(said).toContain("warning:");
    expect(said).toContain(".pdf");
  });

  it("write_file stays exactly as it was when the name and the content agree", async () => {
    const policy = workspace();

    const said = await writeFileTool.execute({ path: "game.md", content: "# Frog Catcher\n" }, policy, execution);

    expect(said).toContain("bytes to");
    expect(said).not.toContain("warning:");
  });

  it("write_file still reports a real failure as a failure", async () => {
    const policy = workspace();
    // A directory where the file should go, which the filesystem itself refuses.
    //
    // The first version of this case used a path outside the workspace and passed nothing: `execute` does
    // not check the sandbox, `gate` does, and calling one without the other tests a door that was never
    // shut here. Worth keeping written down, because the same assumption would make any tool test toothless.
    mkdirSync(join(policy.workspaceRoot, "taken.pdf"));

    const said = await writeFileTool.execute({ path: "taken.pdf", content: "text" }, policy, execution);

    expect(said.startsWith("error:")).toBe(true);
    expect(said).not.toContain("warning:");
  });

  it("edit_file warns on what the file now holds, not on the piece that was pasted", async () => {
    const policy = workspace();
    // A real PDF to begin with, so the edit is what breaks it. The piece being pasted is innocent text.
    writeFileSync(join(policy.workspaceRoot, "report.pdf"), "%PDF-1.7\nplaceholder\n");

    const said = await editFileTool.execute(
      { path: "report.pdf", find: "%PDF-1.7\n", replace: "" },
      policy,
      execution,
    );

    expect(said).toContain("edited");
    expect(said).toContain("warning:");
  });

  it("edit_file says nothing when the edit leaves the format intact", async () => {
    const policy = workspace();
    writeFileSync(join(policy.workspaceRoot, "report.pdf"), "%PDF-1.7\nplaceholder\n");

    const said = await editFileTool.execute(
      { path: "report.pdf", find: "placeholder", replace: "real content" },
      policy,
      execution,
    );

    expect(said).toContain("edited");
    expect(said).not.toContain("warning:");
  });
});
