# `personaxis config`

Read/write configuration values (project `.personaxis/config.json` overrides the global
`~/.personaxis/config.json`).

```bash
personaxis config <key> <value>    # set (e.g. local.endpoint, personas.cmo.model, provider)
personaxis config get <key>        # print the effective value
```

- **Inside the app:** `/config` opens **Settings > Config** (effective values, where each
  one comes from, and in-place Actions: posture, improve mode, default model profile).
  `/config model` jumps to the Command Center's provider wizard.
- Model resolution layers: global < project < per-persona < spec frontmatter < environment
  (`PERSONAXIS_MODEL` / `PERSONAXIS_ENDPOINT`). See `docs/guides/configuration.md` for the
  full any-model/any-mode matrix.
