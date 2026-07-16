/**
 * The alt-screen fullscreen harness (V2-F2.1): it enters the alternate buffer,
 * renders, and ALWAYS restores the primary buffer on exit, the zero-residue
 * contract behind stable modals. A non-TTY caller must NOT emit the escapes.
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { Text, useApp } from "ink";
import { altScreenAvailable, runFullscreen } from "../src/fullscreen.js";

/** A fake write stream that records everything written and can pose as a TTY. */
function fakeStdout(isTTY: boolean): NodeJS.WriteStream & { buf: string } {
  const s: Partial<NodeJS.WriteStream> & { buf: string } = {
    buf: "",
    isTTY,
    columns: 80,
    rows: 24,
    write(chunk: string | Uint8Array): boolean {
      s.buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    },
    on() {
      return s as NodeJS.WriteStream;
    },
    off() {
      return s as NodeJS.WriteStream;
    },
  };
  return s as NodeJS.WriteStream & { buf: string };
}

/** An app that unmounts itself on the next tick. */
function SelfExit(): React.JSX.Element {
  const { exit } = useApp();
  setTimeout(() => exit(), 10);
  return <Text>hello fullscreen</Text>;
}

const ENTER_ALT = "\x1b[?1049h";
const LEAVE_ALT = "\x1b[?1049l";

describe("runFullscreen (alt-screen harness)", () => {
  it("reports availability from the TTY flag and the env opt-out", () => {
    expect(altScreenAvailable(fakeStdout(true))).toBe(true);
    expect(altScreenAvailable(fakeStdout(false))).toBe(false);
  });

  it("enters the alternate buffer and restores it on exit (zero residue)", async () => {
    const out = fakeStdout(true);
    await runFullscreen(<SelfExit />, { stdout: out, stdin: process.stdin });
    expect(out.buf).toContain(ENTER_ALT);
    expect(out.buf).toContain(LEAVE_ALT);
    // The primary buffer is restored (the leave sequence comes after the enter).
    expect(out.buf.lastIndexOf(LEAVE_ALT)).toBeGreaterThan(out.buf.indexOf(ENTER_ALT));
  });

  it("never emits the alt-screen escapes for a non-TTY caller", async () => {
    const out = fakeStdout(false);
    await runFullscreen(<SelfExit />, { stdout: out, stdin: process.stdin });
    expect(out.buf).not.toContain(ENTER_ALT);
    expect(out.buf).not.toContain(LEAVE_ALT);
  });
});
