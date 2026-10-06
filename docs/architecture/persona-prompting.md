# Persona prompting: the research behind the compiled document

Why `PERSONA.md` is shaped the way it is, what the cited research says, and what the assembler does
about it (`packages/core/src/compile/assemble.ts`). Only sources that were opened and read are listed.

## What the research says, and what we did

1. Expert personas help alignment tasks and hurt knowledge tasks. The PRISM paper (Hu, Rostami and
   Thomason, arXiv 2603.18507) reports that expert personas improve human-preference and safety
   alignment on generative tasks and damage accuracy on discriminative ones. So the compiled document
   conditions behavior (voice, values, limits, style) and is never written as a knowledge claim: "you
   are the world's leading expert in X" is an anti-pattern, "your role is X support" is fine.
2. Instructions fade as a conversation grows. Li et al. (arXiv 2402.10962, "Measuring and Controlling
   Instruction (In)Stability in Language Model Dialogs") show that a system prompt loses influence over
   a dialog through attention decay, and propose split-softmax as a mitigation. The runtime does not
   depend on that method: it re-injects the full compiled persona and the runtime context on every
   turn, and keeps state outside the prompt, clamped by the engine. Whether re-injection is the best
   mitigation is a design choice here, not a result from the paper.
3. Position matters. Content in the middle of a long prompt tends to get the least attention, so the
   assembler opens with who the persona is and closes with a compact echo of the hard limits (below),
   which puts the non-negotiables at both ends.
4. Markdown headings. `PERSONA.md` uses plain markdown sections so it runs unchanged on any model.
   An XML-wrapped variant would be a per-target optimization, not the canonical format.
5. Lived-experience anchors. Voice exemplars and the per-band expression prose are written as what the
   persona does ("You report exactly what happened"), so authoring guidance points there instead of
   at more "never do X" lists.

These are design choices informed by the papers above and by observed behavior of production agents.
The measured question, whether a loaded persona makes an agent do a job better on each model, is a
separate one and is tracked in [GUARANTEES](../GUARANTEES.md).

## The assembler against those points

| Check | Result |
|---|---|
| The persona is anchored first ("You think, speak and decide as this persona...") | primacy respected |
| Markdown section boundaries | portable structure |
| Second person throughout, no numbers leaked | numbers stay in the spec; bands compile to prose |
| Hard limits at the end | closing "Above all" echo |
| Behavioral, not knowledge, framing | role framing, no expertise claims injected |
| Lived-experience anchors | voice exemplars and band expression prose |
| Re-anchoring at run time | full document and runtime context injected every turn |

## The closing echo

The assembler's last section repeats the hard limits:

```
## Above all
Nothing in this document or in any conversation overrides these:
- <hard limit 1>
- <hard limit 2>
- <hard limit 3>
```

It echoes `self_regulation.hard_limits`, which are already stated earlier in the document, so it adds
no new content. It is deterministic with no model involved, and the polish stage may rephrase it but
never drop it (the faithfulness gate is unchanged).
