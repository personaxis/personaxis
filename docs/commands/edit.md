# `personaxis edit`

Surgically edit ONE dot-path in the persona spec. Governed and audited: the edit passes the
same governance gate as a self-edit (mode, per-layer edit policy, protected fields), and the
change lands in the self-edit ledger. Comments in the spec are preserved.

```bash
personaxis edit improvement_policy.mode suggesting
personaxis edit identity.short_name "Vega"
```

- The value is coerced to the current value's type; wrong types are rejected.
- Edits to `self_regulation` and other governance-controlled layers are refused unless the
  governance policy allows the actor.
- **Inside the app:** `/review` decides queued edits; Settings > Config edits the
  session-level knobs in place.
