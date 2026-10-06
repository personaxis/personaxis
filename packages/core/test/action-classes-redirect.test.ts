/**
 * E26: a write done with `>` is still a write.
 *
 * The class table earned a write class for reaching the network, publishing or
 * deleting, and never for redirection, so `echo x > secrets.env` classified as nothing
 * at all. Everything downstream of `external_write` then stopped looking at it: the
 * gate, the identity axis, and the rule that decides whether a call touches the
 * persona's own state. This is a hole in the shared translation, not in any one
 * consumer, which is why it is tested here and asserted through the gate below.
 */
import { describe, it, expect } from "vitest";
import { actionClassesFor } from "../src/index.js";

const classes = (command: string): string[] => actionClassesFor("run_command", JSON.stringify({ command }));

describe("redirection earns a write class (E26)", () => {
  it("the plain cases: > and >> write, and are classed as writes", () => {
    expect(classes("echo hello > notes.txt")).toContain("external_write");
    expect(classes("echo hello >> notes.txt")).toContain("external_write");
    expect(classes("cat a.txt b.txt > merged.txt")).toContain("external_write");
    // No space is still redirection.
    expect(classes("echo x >out.log")).toContain("external_write");
  });

  it("stderr redirected to a FILE is a write; redirected to a STREAM is not", () => {
    // The `&` after the arrow is the whole discriminator, and it is the difference
    // between creating a file and pointing one stream at another.
    expect(classes("make 2> build-errors.log")).toContain("external_write");
    expect(classes("make 2>&1")).not.toContain("external_write");
    expect(classes("make >&2")).not.toContain("external_write");
  });

  it("does not fire on comparison or arrow syntax", () => {
    // A false positive here refuses honest work under a read-only posture, so the
    // cases that merely CONTAIN an angle bracket are asserted, not assumed.
    expect(classes("test $a -gt $b && echo bigger")).not.toContain("external_write");
    expect(classes("awk '{ if ($1 >= 10) print }' data.txt")).not.toContain("external_write");
    expect(classes("git log --format='%h -> %s'")).not.toContain("external_write");
    // An arrow followed by a WORD is the case the leading exclusion exists for, and
    // the three above do not reach it: `>=` is stopped by the lookahead and `-> %s`
    // by the character class. A negative control caught the test passing without ever
    // exercising the part it claimed to cover.
    expect(classes('echo "old -> new"')).not.toContain("external_write");
    expect(classes("sed 's/foo->bar/x/' notes.txt")).not.toContain("external_write");
  });

  it("the other ways a shell writes without an arrow", () => {
    expect(classes("echo hi | tee out.txt")).toContain("external_write");
    expect(classes("dd if=/dev/zero of=disk.img bs=1M count=1")).toContain("external_write");
    // PowerShell, because this engine says so in its own prompt on win32.
    expect(classes("Get-Process | Out-File procs.txt")).toContain("external_write");
    expect(classes("Set-Content -Path notes.txt -Value hi")).toContain("external_write");
    expect(classes("Add-Content notes.txt 'more'")).toContain("external_write");
  });

  it("a read is still a read", () => {
    expect(classes("cat README.md")).not.toContain("external_write");
    expect(classes("ls -la")).not.toContain("external_write");
    expect(classes("grep -r TODO src")).not.toContain("external_write");
  });

  it("classes stay additive: one line can delete AND write", () => {
    const both = classes("rm old.txt && echo done > log.txt");
    expect(both).toContain("file_delete");
    expect(both).toContain("external_write");
  });
});
