# D3 Phase 3 brief — per-domain crosswalk and disposition

You own **ONE domain** of the seven-way backend mechanism matrix. Eleven sibling agents own the other eleven domains. Work only in yours.

Read-only. Write exactly one file: `D:\I-harness-main\docs\audit\data\2026-09-11-d3-xw-<yourdomain>.json`.

## Why you exist

Seven independent Phase 1 agents inventoried the seven sources separately, so the **same capability carries different names** in different sources — "append-only shadow projection" in one, "surface-replace compaction" in another. Unioning by name alone would emit hundreds of single-source rows and the matrix would claim seven harnesses share almost nothing. **That would be an artifact of method, not a fact.** Your job is to decide which mechanisms across the seven sources are the SAME capability, and which are not.

This is the highest-judgement step of the whole audit. Getting it wrong in either direction is bad:
- **over-merging** silently claims two different designs are one, hiding a real difference;
- **under-merging** scatters one capability across seven rows, hiding that anyone agrees.

When you are not confident, **do not merge**. Leave them separate — they land in the unreconciled appendix, which is an honest outcome. A row you were unsure about and left separate costs the reader a little; a wrong merge costs them the truth.

## Inputs

- Per-source inventories: `D:\I-harness-main\docs\audit\data\2026-09-11-d3-<source>.json`
  keys: `ih`, `dsh`, `codex`, `opencode` (inside `upstream`), `opencode-fork` (inside `fork`), `grok`, `cc-custom`.
  Each has `domains: { <domain>: [ {name, what, invariants, failurePolicy, constants, evidence, modules, verified} ] }`.
- The domain taxonomy: `2026-09-11-d3-domains.json` (read your domain's `scope`).
- Optionally `2026-09-11-d3-harvest.json` for extra prose on some sources.

## Your task

1. **Collect** every mechanism your domain has, from all seven sources.
2. **Group** them into rows. A row is one capability. Its members are the per-source mechanism names that are the same thing, e.g.:
   `{ "members": { "ih": ["append-only-shadow-projection"], "codex": ["rollout-compacted-replacement-history"], "grok": ["compaction-transcript-shadow"] } }`
   A row may legitimately have only ONE member — that is the "only this harness does this" case and is valuable. But if most rows in your domain are single-member, ask whether you are under-merging.
3. **Name each row** with a canonical kebab-case capability name — the most descriptive of the members, not the shortest.
4. **Assign a disposition** per row, from the closed vocabulary:

| value | meaning |
|---|---|
| `已存在` | I-harness already implements it. **Requires an `ih` member — never use it without one.** |
| `improved-writing` | IH has it and its approach is at least as good as every reference. Also requires an `ih` member. |
| `reuse` | IH lacks it, and a reference's implementation is clean enough to adopt closely. |
| `rewrite` | IH lacks it, but the concept is worth having — build it in IH's idiom (TS ESM, zero-external-dependency where practical, fail-closed, Windows-first), not by transplanting. |
| `遠期` | Real but product-level or large; not now. |
| `不做` | Conflicts with IH's stated principles — e.g. PTC/run_code, executing plugin code, shipping a default LLM provider. |
| `路線差異` | The presence/absence reflects a DIFFERENT DESIGN PHILOSOPHY, not a gap. Use when a source deliberately structures the same capability elsewhere. |

   Rationale: **at most 25 characters, Traditional Chinese.** Concrete, not padding.

5. **Record doubts.** Any row you considered merging but did not, and why, goes in `unmergedDoubts`. This is read by a human and is often the most useful part of your output.

## Hard rules

1. Every mechanism name you cite in `members` **must exist verbatim** in that source's inventory for your domain. Do not invent names, and do not paraphrase.
2. A mechanism may appear in **at most one** row. Do not list the same source mechanism twice.
3. Do not skip mechanisms. Every mechanism in your domain across all seven sources must appear in exactly one row. Count them before you finish.
4. `已存在` and `improved-writing` are **forbidden** on a row with no `ih` member.
5. Do not evaluate or editorialise beyond the disposition rationale. You are grouping and deciding, not reviewing.
6. Where a source's mechanism is noted as **present-but-unwired** or **inert**, preserve that in your reasoning — a complete engine behind an unconnected seam is not a working feature, and the disposition should reflect it (it is usually `rewrite`, not `已存在`).

## Output

```json
{
  "domain": "<your domain id>",
  "rows": {
    "<canonical-row-id>": {
      "domain": "<domain id>",
      "label": "<canonical capability name>",
      "members": { "ih": ["<exact mechanism name>"], "dsh": [], "...": [] },
      "disposition": "rewrite",
      "rationale": "<25 chars max, Traditional Chinese>"
    }
  },
  "unmergedDoubts": [ { "mechanisms": ["a", "b"], "whyNotMerged": "..." } ],
  "coverage": { "mechanismsSeen": 0, "mechanismsPlaced": 0 }
}
```

`mechanismsSeen` must equal `mechanismsPlaced`; count before finishing.

Reply with ONLY: rows produced, cross-source vs single-source counts, the disposition breakdown, and your `unmergedDoubts` in one line each. Do NOT paste the JSON.
