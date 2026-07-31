# `personaxis menu`

Open the Command Center: ONE stable fullscreen hub (alternate screen, zero scrollback
residue) for model config, state, drift, audit, memory, proposals and the persona fleet.

```bash
personaxis menu                    # the scope-tree navigator (default, V9)
personaxis menu --classic          # the classic sectioned hub
personaxis menu --section model    # the classic hub, straight to a section
```

The default (V9) is the **scope-tree navigator**: one recursive view over
`machine → project → persona → layer → field`, with a real breadcrumb path, per-field editing
(envelope-clamped, `Enter` on an editable coordinate), and each action's authority shown
(read-only / review / editable). Inside the REPL, `/menu` opens it (and `/menu classic` the old hub).

The **classic sectioned hub** (`--classic` / `--section`) has the model-config wizard, the config
matrix, and the state/drift/audit/memory/proposals views. The model wizard is also reachable via
`/model` and `personaxis config`.

- **Inside the app:** `/menu` (or Ctrl+K). It opens IN-PROCESS: no child process, instant,
  single-keystroke navigation.
- Scopes: **This project** and **All my projects** (press `g`), fed by the global registry
  plus live presence.

## It always says where you are, and what it acts on

Two lines, on every screen, because being three levels deep with no idea whether you are
configuring one persona, one project or the whole machine is a way to make a mistake:

```
  D410 › cli › Clio
  acting on: this persona · Fleet spans projects
```

The first is the three containers in nesting order (machine › project › persona); the
second names what the current section changes.

## Keys

| Key | Action |
|---|---|
| `↑` `↓` | move |
| `Enter` | open the focused row (the footer names what it will do) |
| `Esc` | back |
| `Tab` | next section |
| `g` | Fleet only: switch between this project and every project |
| `/` | Fleet only: search; `Esc` clears it |
| `q` | quit, from the home screen |

Left and right deliberately do **not** enter and leave. Horizontal keys read as "move
along this row", and firing an action from one turns an exploratory keypress into a
commitment.

## The Fleet

```
   persona               reachable from      who is using it
 ❯ ● main                claude-code+codex   2 instance(s) · this machine (repl) · MacBook (claude-code)
   ○ @helper             not compiled        idle
```

Two different questions that used to be confused: **reachable from** is whether a host
agent could read this persona (its compiled document exists where that host looks);
**who is using it** is who holds it right now. See
[`docs/architecture/presence.md`](../architecture/presence.md).

When the fleet is empty it explains how projects get registered rather than showing a
zero: they register themselves as you use them, and `personaxis overseer scan` finds the
ones that existed beforehand. See
[`docs/architecture/project-registry.md`](../architecture/project-registry.md).
- Headless: the Center needs a TTY; use `personaxis config` / `state show` / `dash --once`.
