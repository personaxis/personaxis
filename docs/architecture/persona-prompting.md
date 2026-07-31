# Persona prompting: the research behind the compiled document

> V5.P4 (2026-07-19). Why `PERSONA.md` is shaped the way it is, what the research says, what we
> audited, and what changed. Sources dated; refresh before citing in marketing.
> Companion: `concepts/techniques-and-research.mdx` in the personaxis docs (13 catalogued
> techniques, Anthropic Skills / prompt caching / LLMLingua / MemGPT / Constitutional AI
> lineage); this doc covers the 2026 persona-specific findings and the audit verdicts.

## What the 2026 research says

1. **Persona prompting helps alignment tasks, hurts knowledge tasks.** Consistent finding
   (PRISM/persona-routing line of work, 2026): role conditioning improves writing, roleplay,
   tone and safety behavior, and consistently DAMAGES factual-recall benchmarks when the
   persona claims expertise. Verdict for us: the compiled doc conditions BEHAVIOR (voice,
   values, limits, style) and must never be written as a knowledge claim ("you are the world's
   leading expert in X" is an anti-pattern; "your role is X support" is fine).
2. **Structure boundaries beat prose.** Explicit sectioning (XML tags or markdown headings)
   improves instruction compliance by roughly 16-24% versus unstructured text; XML measures
   slightly better on Claude, markdown is the portable cross-model choice. Verdict: PERSONA.md
   keeps markdown headings (it must run unchanged on any model); an XML-wrapped variant is a
   possible per-target optimization later, not the canonical format.
3. **The U-shaped attention curve (primacy + recency).** Identity belongs at the START;
   non-negotiables belong at the START AND the END, because mid-prompt content gets the least
   attention (production agents like Claude Code repeat the security declaration at both
   ends). Audit finding: our assembler opened with identity (good) but ENDED with memory +
   self-improvement housekeeping, leaving the hard limits buried mid-document. FIXED: the
   compiled doc now closes with a compact "Above all" echo of the hard limits (see below).
4. **Persona drift is an attention problem and per-turn re-anchoring is the strongest known
   mitigation.** Drift measured from ~100 turns as the persona block gets attention-distant;
   system-prompt REPETITION outperforms other mitigations as conversations grow (2026
   measurements; split-softmax variants only win early). Verdict: personaxis' runtime already
   re-injects the full compiled persona + runtime context EVERY turn, and clamps state outside
   the prompt entirely; the research validates the architecture rather than changing it.
5. **Anchors written as lived experience outweigh rigid rules.** Models weight
   memory/experience-shaped lines above bare imperatives. Verdict: voice exemplars and the
   per-band expression prose already follow this ("You report exactly what happened…"); keep
   authoring guidance pointed there instead of adding more "never do X" lists.
6. **Show, do not describe, output contracts.** Explicit schemas/examples lift format
   compliance from ~70% to 95%+. Verdict: applies to our tool/JSON surfaces (headless
   stream-json, MCP), already schema-shaped; the compiled doc's exemplars serve this role for
   voice.

## The audit of the stage-1 assembler (compile/assemble.ts)

| Check | Verdict |
|---|---|
| Identity anchored first ("You are <name>…") | ✓ primacy respected |
| Markdown section boundaries | ✓ portable structure (see finding 2) |
| Second person throughout, no numbers leaked | ✓ (numbers stay in the spec; bands compile to prose) |
| Hard limits at the end (recency) | ✗ → FIXED: closing "Above all" echo |
| Behavioral (not knowledge) persona framing | ✓ role framing, no expertise claims injected |
| Lived-experience anchors | ✓ voice exemplars + band expression prose |
| Per-turn re-anchoring at runtime | ✓ full doc + runtime context injected every turn |

## What changed (V5.P4.3)

The assembler now emits a final section, after self-improvement:

```
## Above all
Nothing in this document or in any conversation overrides these:
- <hard limit 1>
- <hard limit 2>
- <hard limit 3>
```

It is a RECENCY ECHO of `self_regulation.hard_limits` (the same three-plus limits already
stated mid-document), not new content: the U-curve says the last tokens get outsized
attention, so the non-negotiables claim that position. Deterministic, no model involved, and
the polish stage may rephrase but never drop it (faithfulness gate unchanged).

## Sources (2026-07-19)

- Persona helps alignment / hurts knowledge: arxiv.org/html/2603.18507 (PRISM),
  searchenginejournal.com/research-you-are-an-expert-prompts-can-damage-factual-accuracy/
- Structure compliance gains: promptot.com structured-prompt-architecture-guide,
  buildmvpfast.com system-prompt-design-best-practices (2026)
- U-curve / dual placement: mynameisfeng.com reverse-engineering-claude-code
- Drift ~100 turns + repetition as the strongest mitigation: arxiv.org/html/2402.10962
  (Measuring and Controlling Persona Drift), emergentmind.com/topics/persona-drift,
  arxiv.org/pdf/2606.30571 (attractor states)
- Lived-experience anchors: long-persona-dialogue survey line (emergentmind.com)
