# `personaxis sigil`

Render a persona's **deterministic, state-aware ASCII sigil** + envelope panel, its unique
visual signature, derived from the spec (seed from identity + trait signature, color from the
seed's hue, glyph set from a seed×trait fingerprint).

## Usage
```bash
personaxis sigil [--persona <path>] [--frames <n>]
```
- `--frames <n>` animates `n` breathing frames (extraversion/arousal drive the motion).

Two personas never share a sigil; the same persona renders identically every time. See
`packages/core/src/persona-theme.ts`.
