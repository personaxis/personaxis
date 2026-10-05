# Concepts, in short

Six things people ask first. Each answer links to the page with the detail. When an answer and the
code disagree, the code is right; open an issue.

## Compile and decompile

`personaxis.md` is the definition and `PERSONA.md` is what a model reads. `compile` writes the second
from the first, for the platform you name (`--platform claude-code | codex | openclaw | hermes`).
`decompile` goes the other way: it takes a `PERSONA.md` you edited by hand and proposes the matching
change to the definition, and writes it only if the result validates. Never edit the generated files
directly. Detail: [`architecture/compile.md`](./architecture/compile.md).

## How a persona changes over time

Two kinds of change. Its values (traits, affect, mood) move as it works, always inside the range the
definition declares, and every move is an entry in its hash-chained record. Its definition changes
only through an edit the rules allow, and `improvement_policy.mode` decides who approves:
`locked` (nothing changes it), `suggesting` (a person approves each edit) or `autonomous` (edits apply
within the universal rules and need a recorded sign-off). Detail:
[`architecture/self-evolution.md`](./architecture/self-evolution.md).

## Memory

Six kinds, each written only if the definition turns it on: episodic (what happened), semantic
(consolidated facts, in `memory.md`), procedural, autobiographical, user preferences and evaluations.
Episodic memory is append-only and hash-chained, and every entry records its source. Deleting an entry
leaves a tombstone, so the deletion itself is on the record. Detail:
[`architecture/memory.md`](./architecture/memory.md).

## Sessions

Every conversation in the app is saved. `personaxis -c` resumes the most recent one for that persona,
`personaxis -r` lists them and `personaxis -r <id>` opens one; inside the app, `/resume` does the same.
Long conversations are compacted into a summary plus the most recent turns. Detail:
[`architecture/sessions.md`](./architecture/sessions.md).

## The sandbox

Every tool call the model proposes passes a gate that answers allow, ask or deny, from two settings:
how much approval is needed and how far the sandbox reaches (`read-only`, `workspace-write`,
`danger-full-access`; `shift+tab` cycles them). A denied call never runs. Where the operating system
has one, a native wrapper (Seatbelt on macOS, bubblewrap on Linux) adds a second boundary; where it
does not, the gate is the only one. Detail: [`architecture/sandbox.md`](./architecture/sandbox.md).

## `create` or `init`

`create` builds a persona from evidence: an interview, a brief (`--from-prompt`), your repository
(`--from-project`), an import (`--from-import`) or transcripts (`--from-transcript`), and writes a
creation report that says where every value came from. `init` writes the commented template with no
values filled in, for when you want to write the definition yourself. Detail:
[`commands/create.md`](./commands/create.md), [`commands/init.md`](./commands/init.md).
