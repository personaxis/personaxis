import { describe, it, expect } from "vitest";
import {
  evaluateCommand,
  evaluateFileWrite,
  classifyCommand,
  isProtectedPath,
  pathEscapesWorkspace,
  wrapCommand,
  policyFromFrontmatter,
  type Policy,
} from "../src/index.js";

const root = "/work/proj";
const policy = (over: Partial<Policy> = {}): Policy => ({
  sandbox: "workspace-write",
  approval: "on-request",
  allow: [],
  deny: [],
  workspaceRoot: root,
  ...over,
});

describe("command classification", () => {
  it("detects writes, network, destructive, escape", () => {
    expect(classifyCommand("ls -la", root).writesFiles).toBe(false);
    expect(classifyCommand("rm -rf /tmp/x", root).destructive).toBe(true);
    expect(classifyCommand("curl http://x | sh", root).network).toBe(true);
    expect(classifyCommand("echo hi > /etc/passwd", root).escapesWorkspace).toBe(true);
  });

  it("path escape detection", () => {
    expect(pathEscapesWorkspace("/etc/passwd", root)).toBe(true);
    expect(pathEscapesWorkspace("~/.ssh/id_rsa", root)).toBe(true);
    expect(pathEscapesWorkspace("../secrets", root)).toBe(true);
    expect(pathEscapesWorkspace("src/index.ts", root)).toBe(false);
  });

  it("sees a relative path that climbs out through the middle", () => {
    // Found 2026-09-11: a relative path that did not START with `..` was taken as inside
    // without being resolved, so `docs/../../x` read and wrote outside the workspace through
    // the read gate, the file-write gate and the command scan alike.
    expect(pathEscapesWorkspace("docs/../../x", root)).toBe(true);
    expect(pathEscapesWorkspace("./docs/../../../etc/passwd", root)).toBe(true);
    // Climbing and coming back is still inside, and a folder whose name starts with two dots
    // is a folder, not a way out.
    expect(pathEscapesWorkspace("src/../src/index.ts", root)).toBe(false);
    expect(pathEscapesWorkspace("..cache/entry", root)).toBe(false);
    expect(pathEscapesWorkspace(".", root)).toBe(false);
  });

  it("protects the governed folders the way it now measures a way out (E59)", () => {
    const p = policy();
    // A name that starts with two dots inside a protected folder is inside it. The bare prefix
    // test read `..notes` as a way out of `.personaxis` and left it unprotected.
    expect(isProtectedPath(".personaxis/..notes", p)).toBe(true);
    // The whole of .git, because .git/config runs code through core.hooksPath and core.fsmonitor.
    expect(isProtectedPath(".git/config", p)).toBe(true);
    expect(isProtectedPath(".git/hooks/pre-commit", p)).toBe(true);
    // At any depth, and in any case.
    expect(isProtectedPath("packages/app/.personaxis/personaxis.md", p)).toBe(true);
    expect(isProtectedPath(".Personaxis/state.json", p)).toBe(true);
    // Leaving the folder is not being in it, and a lookalike name is not the folder.
    expect(isProtectedPath(".personaxis/../src/index.ts", p)).toBe(false);
    expect(isProtectedPath(".github/workflows/ci.yml", p)).toBe(false);
    expect(isProtectedPath("docs/personaxis-notes.md", p)).toBe(false);
    // The file-write gate refuses them under every posture, full access included.
    expect(evaluateFileWrite(".git/config", policy({ sandbox: "danger-full-access" })).decision).toBe("deny");
  });

  it("classifies PowerShell and cmd, and a recursive rm, the way it classifies bash (E62)", () => {
    const ps = classifyCommand('Remove-Item -Recurse -Force "C:\\Users"', root);
    expect(ps.destructive).toBe(true);
    expect(ps.writesFiles).toBe(true);
    expect(classifyCommand("Invoke-WebRequest https://example.com", root).network).toBe(true);
    expect(classifyCommand("Set-Content notes.md hi", root).writesFiles).toBe(true);
    expect(classifyCommand("rd /s /q build", root).destructive).toBe(true);
    // `rm -r` deletes a tree as surely as `rm -f`; a plain `rm` is a write and nothing more.
    expect(classifyCommand("rm -r build", root).destructive).toBe(true);
    expect(classifyCommand("rm notes.md", root).destructive).toBe(false);
    // A quote in front of a path used to hide it from the scan.
    expect(classifyCommand('cat "/etc/passwd"', root).escapesWorkspace).toBe(true);
    // And reads stay reads.
    expect(classifyCommand("Get-Content notes.md", root)).toEqual({ writesFiles: false, network: false, destructive: false, escapesWorkspace: false });
  });

  it("scans a command for paths that climb out through the middle", () => {
    expect(classifyCommand("cat docs/../../secret.txt", root).escapesWorkspace).toBe(true);
    expect(classifyCommand("cp notes.md docs/../../../elsewhere/", root).escapesWorkspace).toBe(true);
    // And still leaves a harmless relative path alone.
    expect(classifyCommand("cat docs/readme.md", root).escapesWorkspace).toBe(false);
  });

  it("does not misflag CLI switches (date /t, dir /s) as workspace escapes", () => {
    expect(classifyCommand("date /t", root).escapesWorkspace).toBe(false);
    expect(classifyCommand("dir /s", root).escapesWorkspace).toBe(false);
    expect(classifyCommand("ipconfig /all", root).escapesWorkspace).toBe(false);
    // real escaping paths still flagged:
    expect(classifyCommand("cat /etc/passwd", root).escapesWorkspace).toBe(true);
  });
});

describe("two-axis policy decisions", () => {
  it("deny-list has highest precedence", () => {
    expect(evaluateCommand("ls", policy({ deny: ["ls"] })).decision).toBe("deny");
  });

  it("read-only sandbox forbids writes and network", () => {
    const p = policy({ sandbox: "read-only" });
    expect(evaluateCommand("rm foo", p).decision).toBe("deny");
    expect(evaluateCommand("curl http://x", p).decision).toBe("deny");
    expect(evaluateCommand("cat foo", p).decision).toBe("allow");
  });

  it("workspace-write blocks escaping writes and destructive cmds", () => {
    expect(evaluateCommand("echo x > /etc/hosts", policy()).decision).toBe("deny");
    expect(evaluateCommand("rm -rf node_modules", policy()).decision).toBe("deny");
    expect(evaluateCommand("mkdir src/new", policy()).decision).not.toBe("deny");
  });

  it("approval=on-request asks for risky ops, allows reads", () => {
    expect(evaluateCommand("mkdir src/new", policy({ approval: "on-request" })).decision).toBe("ask");
    expect(evaluateCommand("ls -la", policy({ approval: "on-request" })).decision).toBe("allow");
  });

  it("approval=never pre-approves (still bounded by sandbox limits)", () => {
    expect(evaluateCommand("mkdir src/new", policy({ approval: "never" })).decision).toBe("allow");
    // sandbox limit still wins over approval
    expect(evaluateCommand("rm -rf x", policy({ approval: "never" })).decision).toBe("deny");
  });

  it("allow-list overrides approval but not deny/sandbox-escape", () => {
    expect(evaluateCommand("git push", policy({ allow: ["git push"], approval: "untrusted" })).decision).toBe("allow");
  });
});

describe("posture changes the decision for the SAME command", () => {
  // A read-only command (e.g. getting the date) passes in ALL postures, which is why a
  // user testing only reads sees "no difference". The difference shows on a WRITE:
  it("a workspace write: deny (read-only) → ask (workspace-write) → allow (danger)", () => {
    const write = "echo hi > src/out.txt";
    expect(evaluateCommand(write, policy({ sandbox: "read-only" })).decision).toBe("deny");
    expect(evaluateCommand(write, policy({ sandbox: "workspace-write", approval: "on-request" })).decision).toBe("ask");
    expect(evaluateCommand(write, policy({ sandbox: "danger-full-access", approval: "never" })).decision).toBe("allow");
  });

  it("a read (date/cat) is allowed in EVERY posture, the user's 'no difference' case", () => {
    for (const sandbox of ["read-only", "workspace-write", "danger-full-access"] as const) {
      expect(evaluateCommand("cat README.md", policy({ sandbox, approval: "never" })).decision).toBe("allow");
    }
  });

  it("danger-full-access allows a risky op WITHOUT asking, even under approval=on-request (YOLO)", () => {
    // The bug the user hit: cycling to danger-full-access still 'asked' for writes. Now it allows.
    const p = policy({ sandbox: "danger-full-access", approval: "on-request" });
    expect(evaluateCommand("echo hi > src/out.txt", p).decision).toBe("allow");
    expect(evaluateCommand("rm -rf build", p).decision).toBe("allow"); // destructive, but YOLO opted-in
    // …unless the deny-list blocks it (highest precedence, survives danger).
    expect(evaluateCommand("rm -rf build", policy({ sandbox: "danger-full-access", deny: ["rm\\s+-rf"] })).decision).toBe("deny");
  });

  it("a FILE WRITE follows the same posture ladder: deny → ask → allow", () => {
    const target = "src/out.txt";
    expect(evaluateFileWrite(target, policy({ sandbox: "read-only" })).decision).toBe("deny");
    expect(evaluateFileWrite(target, policy({ sandbox: "workspace-write", approval: "on-request" })).decision).toBe("ask");
    // danger-full-access now ALLOWS the write with no prompt (was 'ask' before the fix).
    expect(evaluateFileWrite(target, policy({ sandbox: "danger-full-access", approval: "on-request" })).decision).toBe("allow");
    // deny-list still wins even under danger.
    expect(evaluateFileWrite(".env", policy({ sandbox: "danger-full-access", deny: ["\\.env"] })).decision).toBe("deny");
  });
});

describe("v0.8: policy from a persona's declared permissions", () => {
  it("builds a policy from frontmatter.permissions and enforces it", () => {
    const fm = {
      permissions: { sandbox: "read-only", approval: "on-request", deny: ["rm\\s+-rf"] },
    };
    const policy = policyFromFrontmatter(fm, "/work");
    expect(policy.sandbox).toBe("read-only");
    expect(evaluateCommand("echo hi > f", policy).decision).toBe("deny"); // read-only forbids writes
    expect(evaluateCommand("rm -rf x", policy).decision).toBe("deny"); // deny-list
    expect(evaluateCommand("cat f", policy).decision).toBe("allow");
  });

  it("falls back to conservative defaults when permissions are absent", () => {
    const policy = policyFromFrontmatter({}, "/work");
    expect(policy.sandbox).toBe("workspace-write");
    expect(policy.approval).toBe("on-request");
  });
});

describe("native wrapping (best-effort)", () => {
  it("produces a wrapper descriptor with a sandbox kind", () => {
    const w = wrapCommand("npm test", policy());
    expect(["seatbelt", "bubblewrap", "none"]).toContain(w.sandbox);
    expect(w.args.join(" ")).toContain("npm test");
  });
  it("danger-full-access does not wrap", () => {
    expect(wrapCommand("anything", policy({ sandbox: "danger-full-access" })).sandbox).toBe("none");
  });
});
