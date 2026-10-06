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
- Inside the app, queued edits are decided in `/persona`, Evolution tab.

| Flag | Effect |
|---|---|
| `--slug <slug>` | edit a sub-persona's spec instead of the root |
| `--force` | allow editing a protected or governance-controlled path (governance can still refuse) |
| `--reason <text>` | rationale recorded in the self-edit ledger |
| `--dry-run` | show the change and its validation, write nothing |
