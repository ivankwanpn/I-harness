# Original settlement source checkpoint — Task1 bounded acceptance

2026-10-28. This accepts Task1 of [the Code Mode owner-lifetime plan](../superpowers/plans/2026-10-28-code-output-owner-lifetime.md). It does not accept Code Mode's cell/global queue integration or the mounted long-session repair. Product remains0.1.13-rc.1/Session13.

Reviewed candidate71d738ea..40e8fea6 received one Important finding. Native and memory drains checked the registered owner revision and hold epoch between records, but a new capture could change the separate capture revision while an earlier record was awaited. A second original record could then issue before the next owner pass. Both checkpoint and close controls reproduced that failure without changing owner revision or hold epoch.

Correction151e768d accounts only for the exact currently drained record's own disposition/removal changes. A new capture or unrelated concurrent revision change stops before the next issue. Final verification still compares the original capture revision and requires a fresh pass. The same reviewer closed the finding; no remaining finding was reported within Task1 or the correction's plausible regressions.

## Accepted behavior

- An original registered source can verify its settled work without retiring its lifetime. Its original descriptor methods and receiver are retained; later calls cannot nominate a different owner.
- Owner settlement precedes native auto-drain. At most two passes verify owner state, captures and repeated hold epochs. A progress result releases only an actual resolved hold belonging to that source, while later records stay owned; it does not declare readiness.
- Lifecycle waits occur outside the settlement lane, allowing the original checkpoint to progress while close waits for its actual terminal condition. Ordinary sources retain their existing close behavior.
- Native and memory paths retain invalid/special captures and original unknown receipt identity. Shared memory recovery prevents another facade for the same Session from bypassing a failure. An optional store refused before issue retains the same handle for later settlement or Stop.
- A thrown registered settlement callback is sticky and invoked once, including raw undefined/null/false/0/empty-string errors. Ordinary unresolved work uses blocked. Delegated sources reject checkpoint after their actual lifetime check and never borrow parent checkpoint authority.

## Integration and evidence

The four reviewed local commits were integrated as72243190,13bb10ba,977053bd andfa2cc96d. All thirteen changed source/test Git blobs match donor151e768d exactly. Main was fixed atfa2cc96df4567553a4e382fd87f52e88ddb86a4f for independent integration execution:

| Scope | Result |
| --- | --- |
| Main memory checkpoint plus existing recovery | 56/56 |
| Main native checkpoint, managed batch and capture retirement | 77/77 |
| Writer final correction, broader affected native compatibility | 125/125 |
| Writer original scoped agent delegation/recovery/retained/unstarted controls | 62/62 |
| Writer affected core-session/persistence types and agent/CodeMode port compatibility | Passed; exact reviewed product preserved |

These overlapping scopes are not summed into a whole-product pass count. Root integration tests each used six new roots and direct installed Node/Vitest, with package CWD, no file parallelism and source hashes unchanged before/after. Root records are under `.superpowers/sdd/2026-10-28-code-output-owner-lifetime/root-integration`. The original failed controls, correction receipts and initial/scoped re-review are preserved in that SDD.

The new two-original-capture controls prove native issue timing[1,3,3]: after A, owner pass2 blocks while B and the late capture remain unissued; later settlement uses their original handles and keys. Ordinary drains and positive two-pass cases remain covered. No producer replay or new public issuance authority was introduced.

## Remaining work

Code Mode still needs the plan's original cell source, single global ordered queue, terminal seal and callback/retention invocation latches. Its adapters, truthful direct-producer cleanup and actual mounted failure/counterexample regressions must then pass independent review. This checkpoint by itself does not fix or qualify the historical lost-output path, public selected-result transfer, full event-driven UI, child instruction callers or the integrated release.
