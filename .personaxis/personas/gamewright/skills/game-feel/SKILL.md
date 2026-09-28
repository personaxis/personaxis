---
name: game-feel
description: Make a game's actions feel responsive and readable, and add feedback in the right order and the right amount. Use when a game feels flat, floaty or unclear, or before finishing any playable build.
allowed-tools: read_file, write_file, edit_file, list_dir, check_page, finish
---

# Game feel

Two different things, and the order between them is the whole skill.

**Feel** is how the game answers input: responsiveness, control curves, forgiveness, camera,
motion. **Juice** is the feedback layer on top: shake, flashes, particles, tweens, sound.

## Do not polish a broken toy

Before adding any effect, check three things:

1. Is the core interaction readable? Can the player tell what just happened?
2. Is the input response crisp? Does the character move on the frame the key goes down?
3. Are outcomes understandable? Does the player know why they lost?

If any answer is no, fix that first. Juice amplifies a good interaction and cannot rescue a bad
one. A game that shakes the screen on every frame is not juicy, it is noisy.

## Every meaningful action speaks in at least three channels

One event, several senses: movement, a visual change, and a sound. A pickup that only increments a
number has spoken once, and the player will miss it.

## The numbers

These are starting values, not laws. Tune them by playing.

- **Screen shake**: 2 to 5 px for a light hit, 8 to 15 px for a heavy one. Duration 0.1 to 0.3 s,
  never longer. It must decay: strongest on the first frame, gone by the last. Bias the direction
  away from the impact.
- **Hit stop**: freeze everything for 2 to 5 frames, roughly 30 to 80 ms, on a heavy impact. This
  is what sells weight, and it costs nothing.
- **Flash**: 1 to 2 frames of white or a colour shift on whatever was hit.
- **Easing**: ease-out for anything arriving (fast start, slow end), ease-in for anything building
  momentum, a small overshoot for anything playful. Linear motion reads as mechanical.
- **Sync**: the visual, the sound and the shake land on the same frame. A few frames of drift feels
  wrong even when the player cannot say why.

## Forgiveness

Players blame the game for what feels unfair, so build in the slack good games hide:

- **Coyote time**: a jump still works for 3 to 5 frames after leaving the ground.
- **Input buffer**: a jump pressed up to 5 frames early fires on landing.
- **Generous hitboxes** for the player, tight ones for the player's attacks.

## Accessibility

Shake, flash and freeze are exactly the effects that hurt some players. Keep them proportional,
never stack a full-screen flash with a long shake, and if the game has any options at all, let the
player turn them down.
