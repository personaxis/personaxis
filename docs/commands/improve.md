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

| mode | behavior (qualitative self-edits to the layer-10 `persona` prompting fields) |
|---|---|
| `locked` | the spec never self-edits — humans only. |
| `suggesting` | the persona PROPOSES edits; they QUEUE in the ledger for batch approval via `/review`. |
| `autonomous` | proposals auto-apply, still gated by consensus + protected paths + the `user`-trust provenance gate. |

> The mode governs **qualitative** evolution (prose). Numeric envelope nudges (mood/affect) are
> cheap, clamped and reversible, so `suggesting` and `autonomous` behave the same for them — only
> `locked` stops them. Review queued qualitative proposals with `/review` in the REPL.

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
