# `personaxis arbitrate`, deterministic value conflicts

The algorithm the spec's `weight` field always promised (SPEC §15):

```bash
personaxis arbitrate                       # the full ranking
personaxis arbitrate safety completion     # resolve one conflict, explained
personaxis arbitrate a b --json
```

Order: `type: governance` beats non-governance → higher `weight` wins →
lexicographic name breaks ties. Total, antisymmetric, transitive, the same two
values resolve the same way every time, in either argument order, with a trace
naming the deciding rule.

**U7 is a theorem here**: by universal U6, `safety` is governance-typed with
weight ≥ 0.90, so it wins every conflict with a task value by the first rule, 
`conflict_resolution.safety_over_completion` is derivable (the flag remains
required for interop). A non-safety value declared `type: governance` with
weight ≥ safety's draws the `arbitration-governance-outranks-safety` lint warning.

Also `/arbitrate` in the REPL.
