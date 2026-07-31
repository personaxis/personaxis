/**
 * V9 / G.4: the navigator renders ANY node the same way and drills. One useInput owns the
 * keyboard (no double-Enter), Enter drills into a child, Esc climbs one level and exits at the
 * root, the breadcrumb is the real path, and an edit's effect is shown (a protected layer reads
 * "read-only").
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeStarterPersona } from "../src/starter.js";
import { personaTree } from "../src/center/tree.js";
import { ScopeNavigator } from "../src/center/navigator.js";
import type { ScopeNode } from "../src/center/tree.js";

process.env.PERSONAXIS_NO_ANIM = "1";
const ENTER = "\r";
const ESC = "\x1b";
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 25));
const strip = (s: string | undefined): string => (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");

let dir: string;
let mainPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-nav-"));
  mainPath = writeStarterPersona(dir, "Vega");
  writeStarterPersona(dir, "Legal", "legal");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Walk the fixture tree by path, so the navigator resolves against it (not the global registry). */
function makeResolve(root: ScopeNode): (path: string[]) => ScopeNode | null {
  return (path) => {
    if (path.length < root.path.length) return null;
    let node: ScopeNode = root;
    for (const seg of path.slice(root.path.length)) {
      const next = node.children().find((c) => c.id === seg);
      if (!next) return null;
      node = next;
    }
    return node;
  };
}

function mount(onExit = () => {}, onEdit?: (n: ScopeNode, a: unknown, v: string) => void) {
  const root = personaTree(mainPath, "", []); // root.path === ["main"]
  return render(
    <ScopeNavigator resolve={makeResolve(root)} initialPath={["main"]} onExit={onExit} onEdit={onEdit as never} />,
  );
}

/** Drill to a layer so its FIELDS are the focused children: main → Layers → first layer. */
async function drillToField(stdin: { write: (s: string) => void }, flushFn: () => Promise<void>): Promise<void> {
  stdin.write(ENTER); // Layers (index 0)
  await flushFn();
  stdin.write(ENTER); // first layer → now at a layer, fields are its children (first field focused)
  await flushFn();
}

describe("scope navigator (G.4)", () => {
  it("renders the breadcrumb path and the node's children", async () => {
    const { lastFrame } = mount();
    await flush();
    const out = strip(lastFrame());
    expect(out).toContain("main"); // breadcrumb
    expect(out).toContain("Layers");
    expect(out).toContain("Permissions");
  });

  it("Enter drills into the focused child; the breadcrumb grows", async () => {
    const { stdin, lastFrame } = mount();
    await flush();
    stdin.write("\x1b[B"); // down → focus Permissions (index 1)
    await flush();
    stdin.write(ENTER); // drill
    await flush();
    const out = strip(lastFrame());
    expect(out).toContain("main › permissions"); // real breadcrumb
    expect(out).toContain("identity"); // permissions lists the 10 canonical layers
  });

  it("shows an edit effect: a protected layer reads read-only", async () => {
    const { stdin, lastFrame } = mount();
    await flush();
    stdin.write("\x1b[B");
    await flush();
    stdin.write(ENTER); // into Permissions
    await flush();
    // identity/character are the safety floor → blocked → "read-only" badge in the list.
    expect(strip(lastFrame())).toContain("read-only");
  });

  it("Esc climbs one level, and exits at the root", async () => {
    let exited = false;
    const { stdin, lastFrame } = mount(() => (exited = true));
    await flush();
    stdin.write("\x1b[B");
    await flush();
    stdin.write(ENTER); // main › permissions
    await flush();
    expect(strip(lastFrame())).toContain("permissions");

    stdin.write(ESC); // back to main
    await flush();
    expect(strip(lastFrame())).not.toContain("› permissions");
    expect(exited).toBe(false);

    stdin.write(ESC); // at root → exit
    await flush();
    expect(exited).toBe(true);
  });

  it("Enter on an editable field opens edit mode; typing + Enter calls onEdit", async () => {
    const edits: Array<{ id: string; value: string }> = [];
    const { stdin, lastFrame } = mount(
      () => {},
      (node, _action, value) => edits.push({ id: node.id, value }),
    );
    await flush();
    await drillToField(stdin, flush);
    // A field is a leaf with an "editable" (direct) action → Enter opens edit mode.
    stdin.write(ENTER);
    await flush();
    expect(strip(lastFrame())).toMatch(/set .*:/); // the inline prompt

    for (const ch of "0.42") stdin.write(ch);
    await flush();
    stdin.write(ENTER); // apply
    await flush();
    expect(edits).toHaveLength(1);
    expect(edits[0].value).toBe("0.42");
    expect(edits[0].id).toMatch(/\./); // a dot-path coordinate key
  });

  it("a blocked (protected) leaf never opens edit mode", async () => {
    const edits: string[] = [];
    const { stdin } = mount(
      () => {},
      (_n, _a, v) => edits.push(v),
    );
    await flush();
    stdin.write("\x1b[B"); // down → Permissions
    await flush();
    stdin.write(ENTER); // into Permissions (children = layers; identity is index 0, blocked)
    await flush();
    stdin.write(ENTER); // Enter on identity (blocked) → must NOT open edit mode
    await flush();
    for (const ch of "9.9") stdin.write(ch);
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(edits, "a blocked field cannot be edited").toHaveLength(0);
  });
});
