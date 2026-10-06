# `personaxis config`

Read/write configuration values (project `.personaxis/config.json` overrides the global
`~/.personaxis/config.json`).

```bash
personaxis config set <key> <value>   # e.g. local.endpoint, personas.cmo.model, provider (-g writes the global file)
personaxis config get <key>           # print one value (-g reads the global file only)
personaxis config show                # project and global config, keys masked
personaxis config use <profile>       # make a profile the default (--persona <slug> for one persona, -g for global)
```

- Inside the app, `/status` has a Config tab (effective values and where each one comes from)
  and `/model` opens the provider menu.
- Precedence is environment, then project, then global (`PERSONAXIS_MODEL` and
  `PERSONAXIS_ENDPOINT` are the environment variables). See
  [configuration](../guides/configuration.md) for the full any-model, any-mode matrix.
