---
name: game-design-document
description: Write the design document for a game, from a request of any size, so that somebody else could build the game from it. Use when asked to design a game, spec a game, or write a GDD.
allowed-tools: read_file, write_file, edit_file, list_dir, check_page, finish
metadata:
  personaxis:
    delivers: [GAME.md]
---

# The design document

A design document exists so that somebody who was not in the room can build the game, and somebody
who is paying for it can judge it. It is not a pitch. Write for a reader who has to act on it.

## One focus

The document has one objective, named in its title. One objective may contain several systems, but
a document about two games is two documents. If the request is vague, choose the smallest game that
honestly answers it and say in one line what you chose and what you left out. Do not ask for
clarification instead of deciding: decide, and state the decision where the reader can overrule it.

## What it must contain

Write these sections, in this order, and do not pad them:

1. **What the game is.** Two or three sentences: the genre, the player's role, and the fantasy. A
   reader must finish this paragraph able to describe the game to someone else.
2. **Core loop.** The thing the player does over and over, second to second, as a short numbered
   cycle of three or four actions. Then the loop above it, minute to minute, and the loop above
   that if the game is long enough to have one. A loop is challenge, action, reward, and back to
   challenge; if one of those three is missing, the loop is not a loop.
3. **Controls.** Every input the player has, and what it does. If there are three keys, say three
   keys. A control that the prototype does not implement does not belong here.
4. **Rules.** Win condition, lose condition, scoring, and what the opposition does. Detailed enough
   that the game could be played on a table with paper and counters. This is the test: if you
   cannot play it on paper, the rules are not written yet.
5. **Difficulty.** How the game gets harder, in terms the builder can implement: which number
   moves, from what to what, over how long. "It gets harder over time" is not a difficulty curve.
   The first thirty seconds must be winnable by someone who has never played it.
6. **Scope.** What is in this version and what is deliberately not. A list of what is out is worth
   more than a list of what is in, because it is the list nobody writes.

## Rules

- **One loop done well beats five half-finished systems.** Cut a system rather than describe it
  thinly. If the scope section is long, the game is too big.
- **Every number is a decision, so give it a reason.** Not "enemies spawn quickly" but "one enemy
  every 2 s at the start, one every 0.8 s after 60 s, because the player needs half a minute to
  learn the dodge before the screen fills".
- **The document and the prototype say the same thing.** If the prototype has two lives and the
  document says three, the document is wrong. Never ship a document whose game nobody can play.
- **No marketing.** No "immersive", no "revolutionary", no "engaging experience". Say what the
  player does.
