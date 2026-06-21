import { describe, it, expect } from "vitest";
import {
  evaluateCommand,
  classifyCommand,
  pathEscapesWorkspace,
  wrapCommand,
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
