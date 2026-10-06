# `personaxis ps`

Fleet view for THIS project: **who is holding** each persona right now and through what
surface, plus its mutation count, tone and last state change.

```bash
personaxis ps
```

```
  PERSONA             HELD BY        MUT   TONE    LAST CHANGE
  (root)              repl · serve     3   -0.10   14:22:01
    answering
  cmo                 nobody           -     -       -
```

- **HELD BY** lists the surfaces currently attached, deduplicated, or `nobody`. It reads the
  per-instance presence files (`.personaxis/presence/`), so a holder that crashed drops off
  by heartbeat age rather than lingering. See
  [the presence design](../architecture/presence.md) for who announces and who does not.
- The **detail line** appears only when it has something the row cannot say: a holder on
  **another machine**, which is the collision this view exists to reveal, and what the
  holders are doing.
- **MUT / TONE / LAST CHANGE** come from the state marker: the mutation count, the current
  `mood.tone`, and when the state last moved. That is a different question from who is
  attached, and the columns keep it separate. A persona can be held by three surfaces with
  its state untouched for a week, or evolve on a schedule with nobody attached.
- A held **write lease** prints under the row, because it changes what other machines may
  do and a fleet view that omitted it would show a persona as available when it is not.
- **Inside the app:** the Command Center's **Fleet** section shows the same, live, with
  drill-down; press `g` for the all-projects scope (global registry).
