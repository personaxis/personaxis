# `personaxis decompile`

The reverse of `compile`: take a hand-edited compiled `PERSONA.md` and propose an updated
`personaxis.md` that reflects the edit, then re-validate it before writing. Use it when you
changed the compiled document by hand and want the spec to match.

## Usage
```bash
personaxis decompile [slug] [--root] [--provider <name>] [--from-file <path>]
```

## What it does
1. Reads the current `personaxis.md` + the edited compiled doc.
2. Asks the provider to map the prose edits back to spec fields, including persona-prompting:
   voice samples → `voice_exemplars`, situations → `scene_contracts`, Always/Never →
   `behavioral_anchors`, staying-in-character → `break_character_guardrails`,
   fixed/evolving/situational → `consistency`. It must never weaken a safety universal.
3. Strips a wrapping code fence if the provider added one.
4. **Validates** the proposed spec. If it fails, prints the failing fields and **writes
   nothing** (the spec is never corrupted by a bad LLM response).

## Safety
Decompile writes the spec only if the proposed result validates. A `FAIL_SCHEMA`,
`FAIL_POLICY` or `FAIL_CONCEPTUAL` result aborts with the exact failing field and writes
nothing.

## Example
```bash
# edit PERSONA.md by hand, then fold it back:
personaxis decompile --root
```
