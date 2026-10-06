# `personaxis sigil` (and the aura)

Two visuals, one seed (the sha-256 of the persona's canonical id):

- The aura is the persona's face in the app: a small animated creature whose anatomy
  (head shape, antennae, torso, arms, legs, particle crown), colors and animation rhythm
  (breath, blink, gait, orbit) all derive deterministically and independently from the
  seed. Live state shows through it: affect intensity brightens the face, and passing a drift
  threshold flares the crown. You see it at startup, in `/persona`, on the card and in the Command Center.
- The sigil is the abstract glyph used for hashes, cards and signatures, the compact,
  symbol-like signature that `sign`/`verify`/`card` embed.

## Usage

```bash
personaxis sigil [--persona <path>] [--frames <n>]   # render the sigil + envelope panel
personaxis card                                      # the shareable card (aura + stats)
```

`--frames <n>` prints n breathing frames. `PERSONAXIS_NO_ANIM=1` pins frame 0 everywhere
(CI-deterministic).
