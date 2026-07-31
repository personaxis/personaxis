/**
 * `personaxis console` (V9 / G.5): headless access to the Command Center scope tree, for coding
 * agents and CI that cannot drive a TUI. It serializes the SAME tree the navigator renders
 * (`center/tree.ts`), so there is one model behind both surfaces: `ls` a node's children, `get`
 * its attributes and actions, `do` an action (honoring the authority, a `blocked` action is
 * refused, a governed edit is what the tree already declared).
 *
 * A path is the node's id-path, `/`-separated: `machine/<project>/<persona>/layers/<layer>/<coord>`.
 */

import { Command } from "commander";
import { nodeAt, walkFrom, personaTree, type ScopeNode } from "../center/tree.js";
import { applyFieldEdit } from "../center/edit.js";

/**
 * Resolve against the machine tree by default, or against a single persona when `--persona` is
 * given (paths then start at `main`). The persona form needs no project registry, so an agent can
 * target a persona it already knows without it being registered.
 */
function resolver(personaPath?: string): (pathStr: string) => ScopeNode | null {
  if (!personaPath) return (p) => nodeAt(p.split("/").filter(Boolean));
  const root = personaTree(personaPath, "", []); // root.path === ["main"]
  return (p) => walkFrom(root, p.split("/").filter(Boolean));
}

/** JSON-safe view of a node: children() is a function, personaPath is a runtime hint, both dropped. */
function serialize(node: ScopeNode): Record<string, unknown> {
  return {
    level: node.level,
    id: node.id,
    title: node.title,
    path: node.path,
    attributes: node.attributes,
    actions: node.actions.map((a) => ({ id: a.id, label: a.label, kind: a.kind, effect: a.effect, authority: a.authority })),
    children: node.children().map((c) => ({ id: c.id, title: c.title, level: c.level, effect: editEffect(c) })),
    ...(node.live ? { live: node.live } : {}),
  };
}

function editEffect(node: ScopeNode): string | undefined {
  return node.actions.find((a) => a.kind === "edit")?.effect;
}

function notFound(path: string): void {
  console.error(`no node at "${path}" (start from "machine")`);
  process.exitCode = 1;
}

export const consoleCommand = new Command("console").description(
  "Headless access to the Command Center scope tree (ls / get / do) for agents and CI.",
);

consoleCommand
  .command("ls <path>")
  .description("list the children of the node at <path>")
  .option("--json", "machine-readable output")
  .option("--persona <path>", "target one persona (paths start at 'main')")
  .action((path: string, opts: { json?: boolean; persona?: string }) => {
    const node = resolver(opts.persona)(path);
    if (!node) return notFound(path);
    const kids = node.children();
    if (opts.json) {
      console.log(JSON.stringify(kids.map((k) => ({ id: k.id, title: k.title, level: k.level, effect: editEffect(k) })), null, 2));
      return;
    }
    if (!kids.length) return console.log("  (leaf: nothing below)");
    for (const k of kids) {
      const eff = editEffect(k);
      console.log(`  ${k.id.padEnd(28)} ${k.title}${eff ? `   [${eff}]` : ""}`);
    }
  });

consoleCommand
  .command("get <path>")
  .description("show the attributes and actions of the node at <path>")
  .option("--json", "machine-readable output")
  .option("--persona <path>", "target one persona (paths start at 'main')")
  .action((path: string, opts: { json?: boolean; persona?: string }) => {
    const node = resolver(opts.persona)(path);
    if (!node) return notFound(path);
    if (opts.json) return void console.log(JSON.stringify(serialize(node), null, 2));
    console.log(`${node.title}  (${node.level})`);
    console.log(`  path: ${node.path.join("/")}`);
    for (const a of node.attributes) console.log(`  ${a.key}: ${a.value}${a.note ? `  (${a.note})` : ""}`);
    if (node.actions.length) {
      console.log("  actions:");
      for (const a of node.actions) console.log(`    ${a.id} (${a.kind}) → ${a.effect}${a.authority ? `  · ${a.authority}` : ""}`);
    }
  });

consoleCommand
  .command("do <path> <action> [value]")
  .description("run <action> on the node at <path> (e.g. `edit 0.5` on a coordinate)")
  .option("--json", "machine-readable output")
  .option("--persona <path>", "target one persona (paths start at 'main')")
  .action((path: string, actionId: string, value: string | undefined, opts: { json?: boolean; persona?: string }) => {
    const node = resolver(opts.persona)(path);
    if (!node) return notFound(path);
    const action = node.actions.find((a) => a.id === actionId);
    if (!action) {
      console.error(`no action "${actionId}" on this node; available: ${node.actions.map((a) => a.id).join(", ") || "(none)"}`);
      process.exitCode = 1;
      return;
    }
    if (action.effect === "blocked") {
      console.error(`refused: ${action.authority ?? "blocked"}`);
      process.exitCode = 1;
      return;
    }
    if (action.kind === "edit") {
      const r = applyFieldEdit(node, value ?? "");
      const payload = { ok: r.ok, message: r.message };
      console.log(opts.json ? JSON.stringify(payload, null, 2) : r.message);
      if (!r.ok) process.exitCode = 1;
      return;
    }
    // Navigate/other actions have no side effect here; the tree is data.
    console.log(opts.json ? JSON.stringify({ ok: true, action: action.id, effect: action.effect }, null, 2) : `${action.label}: ${action.effect}`);
  });
