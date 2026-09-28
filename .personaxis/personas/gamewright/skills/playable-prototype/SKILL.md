---
name: playable-prototype
description: Build a game that actually runs, as one HTML file a person can open in a browser with no build step and no network. Use whenever a game has to be played, demonstrated or judged, not just described.
allowed-tools: read_file, write_file, edit_file, list_dir, check_page, finish
metadata:
  personaxis:
    delivers: [game.html]
---

# The playable prototype

A design nobody can play is an opinion. The prototype is the evidence.

## The shape

**One file, `game.html`.** Markup, CSS and JavaScript inside it. It opens by double-clicking. It
needs no server, no build step, no package install, and no network: no CDN script, no web font, no
remote image, no analytics. A prototype that needs the internet is a prototype that will not run in
the room where it matters.

No external assets at all. Draw with `<canvas>` or with positioned DOM elements. Make sound, if the
game has sound, with the Web Audio API's oscillators, not with audio files.

## The skeleton

```html
<!doctype html>
<meta charset="utf-8">
<title>The game's name</title>
<style>
  html, body { margin: 0; height: 100%; background: #12131a; display: grid; place-items: center; }
  canvas { image-rendering: pixelated; touch-action: none; }
</style>
<canvas id="screen" width="480" height="320"></canvas>
<script>
  const screen = document.getElementById("screen");
  const ctx = screen.getContext("2d");
  const keys = new Set();
  addEventListener("keydown", (e) => { keys.add(e.code); if (e.code === "Space") e.preventDefault(); });
  addEventListener("keyup", (e) => keys.delete(e.code));

  const state = { /* everything the game is, in one object */ };

  function update(dt) { /* move the world by dt seconds */ }
  function draw() { /* paint state; read nothing, change nothing */ }

  let last = performance.now();
  requestAnimationFrame(function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05); // a tab that was in the background must not teleport the world
    last = now;
    update(dt);
    draw();
    requestAnimationFrame(frame);
  });
</script>
```

## Rules

- **Time in seconds, never in frames.** Multiply every speed by `dt`. A game tuned to 60 fps breaks
  on a 144 Hz screen.
- **Update and draw stay apart.** `draw` paints the state and changes nothing.
- **One state object.** Restarting the game means rebuilding it, not unpicking twenty variables.
- **It must be finishable.** There is a way to win and a way to lose, both reachable in the first
  couple of minutes, and both say so on screen. A prototype that runs forever with no outcome has
  not been tested by anyone.
- **The player is told the controls**, on screen, before they need them. One line is enough.
- **It matches the document.** Same controls, same rules, same numbers. Where you had to change
  something while building, change the document too and say why.

## Before calling it done

Open it. Play it for a minute. Check: it starts without an error in the console, the controls do
what the document says, you can lose, you can win, and it restarts without reloading the page.
