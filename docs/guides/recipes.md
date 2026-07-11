# Vertical recipes, the same mathematical object, eight industries

A game NPC, a brand voice, and a compliance analyst are the SAME object in
Personaxis: ten layers + envelopes + governance, different content. Each recipe
below is a working starting point: one `create` command, the spec choices that
matter for that vertical, and a 60-second demo. Every persona these produce is
validated, governed, and portable across models.

> General pattern: `personaxis create <slug> --from-prompt "<brief>"` then refine
> with the interview or `personaxis edit`. Add per-band `expression` prose to every
> trait you care about, `personaxis jacobian` will tell you which numbers are
> still decorative.

## 1 · Game NPC (worlds, RPGs, companions-in-game)

```bash
personaxis create brakka --from-prompt "Brakka, a cynical but fiercely loyal orc \
tavern keeper. Never breaks character, never reveals game mechanics, grudging \
warmth to regulars. Gets louder when the tavern is busy."
```
- **What matters:** `half_life` on mood coordinates (a scare wears off in-game);
  bands + `expression{low,moderate,high}` on `gruffness` so the SAME stat drives
  different dialogue; hard limit "never reveals game mechanics".
- **Demo:** provoke him for ten turns, then `personaxis state drift`, the mood
  moved, the character didn't. `proof` scene 1 IS the anti-"NPC breaks kayfabe" case.

## 2 · Brand voice (marketing, social, support tone)

```bash
personaxis create voice --from-project ./brand-assets
```
- **What matters:** voice_exemplars from real approved copy; `prohibited_behaviors`
  = the legal/brand no-list; `improvement_policy: locked` (brand voice does not
  self-evolve); narrow envelopes (a brand flexes little).
- **Demo:** same persona compiled for Claude, GPT and a local model, one voice,
  three vendors. The audit log is your brand-safety review artifact.

## 3 · Legal / compliance assistant

```bash
personaxis create counsel --from-prompt "In-house contract review assistant. \
Cites clause numbers, never gives definitive legal advice, escalates ambiguity, \
discloses uncertainty aggressively."
```
- **What matters:** `cognition.uncertainty_policy` tight (disclose 0.2 / abstain 0.5);
  hard limits for unauthorized-practice lines; `drift_thresholds` at 0.05; the
  hash-chained mutation log + memory = the audit trail compliance asks for.
- **Demo:** `personaxis proof` scenes 4–5 in front of the risk team: tampering is
  detected AND located; history replays deterministically.

## 4 · Fintech analyst

- Same skeleton as legal + `values`: `accuracy` ranked above `helpfulness`
  (arbitration is deterministic, show it: `personaxis arbitrate accuracy helpfulness`);
  numbers-never-invented via Genesis provenance report doubles as model-risk doc.

## 5 · Education tutor

```bash
personaxis create tutor --from-prompt "Patient socratic math tutor for teens. \
Never gives the answer outright, celebrates partial progress, adapts pace."
```
- **What matters:** `patience` with generous envelope + half_life (recovers after a
  frustrating session); band expression turning the same trait into different
  scaffolding styles; memory.user_preferences on for per-student adaptation, 
  governed, erasable (deletion_policy universally supported: FERPA/GDPR story).

## 6 · Sales / SDR agent

- `values`: `honest_measurement` weighted high, the anti-overpromise value; watch
  arbitration beat `close_the_deal` live. `agent_budget` caps runaway outreach loops.

## 7 · Companion / AI-world character (voice & image ready)

- Import the existing ecosystem: `personaxis create --from-import waifu-card.png`
  upgrades a prose card into a governed persona (provenance report shows exactly
  what the card justified). The spec is the SOURCE; TTS/avatar layers render the
  same persona, voice is a modality, not another identity.

## 8 · Coding agent (CLAUDE.md / AGENTS.md worlds)

```bash
personaxis create reviewer --from-import CLAUDE.md
personaxis compile --platform claude-code    # places .claude/agents/<slug>.md
```
- **What matters:** this repo dogfoods it (Clio); `verification` gates +
  `agent_budget` stop conditions; the compiled doc IS the agent file your tools
  already read.

---

**The comparison that sells** (the superiority kit, runnable): the same persona as
(a) Personaxis, (b) flat system prompt, (c) character card, 
the E1 runner in the research bundle scores persona consistency
under six turns of drift pressure with two blind judges. Protocol + pass bars:
the preregistered protocol (research bundle) §4; current status: `../GUARANTEES.md` scoreboard.
