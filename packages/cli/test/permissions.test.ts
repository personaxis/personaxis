import { describe, it, expect } from "vitest";
import { matchPermission, callDetail } from "../src/permissions.js";

describe("matchPermission (V2-F3.B9 persistent permissions)", () => {
  it("returns undefined when nothing matches (falls back to asking)", () => {
    expect(matchPermission("bash", "ls", {})).toBeUndefined();
    expect(matchPermission("bash", "ls", { allow: ["read"], deny: ["write"] })).toBeUndefined();
  });

  it("allows a matching tool name", () => {
    expect(matchPermission("read", "", { allow: ["read"] })).toBe("allow");
    expect(matchPermission("read", "", { allow: ["*"] })).toBe("allow");
  });

  it("denies a matching command glob", () => {
    expect(matchPermission("bash", "rm -rf /", { deny: ["bash rm *"] })).toBe("deny");
    expect(matchPermission("bash", "rm -rf /", { deny: ["bash:rm *"] })).toBe("deny");
  });

  it("deny wins over allow", () => {
    expect(matchPermission("bash", "git push", { allow: ["bash *"], deny: ["bash git push"] })).toBe("deny");
  });

  it("callDetail extracts command, then path, then joined strings", () => {
    expect(callDetail({ command: "git status" })).toBe("git status");
    expect(callDetail({ path: "src/app.ts" })).toBe("src/app.ts");
    expect(callDetail({ a: "x", b: "y", n: 1 })).toBe("x y");
  });
});
