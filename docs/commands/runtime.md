# `personaxis runtime`

> ⚠️ **Requires a Personaxis backend account.** These subcommands call the hosted REST API at
> `personaxis.com` (auth via `PERSONAXIS_API_KEY`). Without an account they won't work, the managed
> backend is not built/published yet (see the managed-SaaS design). For **local** use, you don't need
> this: `observe`/`watch`/`serve` + the [integrations](../integrations/README.md) cover the local flow.

Open **hosted** runtime sessions against a published persona version, append traces, and evaluate
against assertions (CI compliance gates).

```bash
personaxis runtime start <version>
personaxis runtime trace <session> …
personaxis runtime end <session>
personaxis runtime evaluate <session> …
```

| Subcommand | Meaning |
|---|---|
| `start` | Open a hosted session against a persona version. |
| `trace` | Append a trace to an open session. |
| `end` | Mark a session ended. |
| `evaluate` | Evaluate a session against assertions. |
