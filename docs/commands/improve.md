# `personaxis improve`

View or set the persona's **self-improvement posture** (`improvement_policy.mode`) — the switch
that governs whether the spec may evolve itself. See
[../architecture/self-evolution.md](../architecture/self-evolution.md).

## Usage
```bash
personaxis improve [mode] [--persona <path>]
```
- no `mode` → print the current mode.
- `mode` ∈ `locked | suggesting | autonomous`.

| mode | behavior |
|---|---|
| `locked` | the spec never self-edits — humans only. |
| `suggesting` | the persona PROPOSES edits; they queue for approval (consensus). |
| `autonomous` | proposals auto-apply, still gated by consensus + protected paths. |

## How it writes
Comment-preserving text surgery on the `improvement_policy.mode` line in the `personaxis.md`
frontmatter — the source the runtime reads (`readMode`). The REPL has the same control as
`/improve`.

## Examples
```bash
personaxis improve                 # show current mode
personaxis improve suggesting      # enable governed self-edit proposals
```

> Not to be confused with the REPL `/mode` (sandbox posture). `improve` is the
> self-improvement posture.
