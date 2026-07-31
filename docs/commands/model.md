# `personaxis model`

Show the resolved model per persona (main + subs), or set model config, scriptable for
agents and CI. Keys are NEVER printed.

```bash
personaxis model                 # human-readable resolution per persona
personaxis model --json          # machine-readable: model + endpoint per persona
personaxis model set <name>                      # set the model for the default profile
personaxis model set endpoint https://...        # set a field
personaxis model set <name> --persona cmo        # assign to one sub-persona
personaxis model set <name> --persona main --project   # this project's main persona
```

- **Inside the app:** `/model` shows the resolved model and opens the provider menu (the
  Command Center's Model section); textual `set` stays available for pipes.
- Fallback: with no explicit choice, the default profile is used; profiles with a real key
  win over local ones without a server. Provider errors in the app come with the exact fix.
