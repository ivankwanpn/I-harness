# Ordinary child delivery recovery — scoped acceptance

MAIN fast-forwarded from `f0799e04` to reviewed and tested `5a9503cc`. The source tree is exactly the accepted candidate; no unrelated integration change required repeating identical tests. This closes internal event Unit1, not the complete event-driven version.

A genuine failed child could remain pending after temporary recipient admission errors because notification bookkeeping swallowed the original failure before the existing service retry owner saw it. Failure occurrence now survives even for falsey thrown values; original nominal errors reach the original retry drain after notification state is saved. Initial cold recovery also activates that same drain after an initial refusal. No new producer execution, receipt identity, completion registry, model lane or healthy-state polling was added.

Real before/after controls preserved the same child launch, failed terminal, result revision and retained bytes across three transient refusals, producing one receipt, one promotion and one additional parent request without a new human prompt. A separate actual cold process-cut control reproduced and closed the initial activation hole. Independent source review and scoped followup review approved the final source; ROOT inspected both reports and the concrete composition diff.

Final candidate evidence: 58 connected tests passed with one explicit baseline negative excluded; four selected cold controls passed; subagent protocol/spawn/notification47 and corrected notification24 passed; actual CLI3 and selected Team5 passed; subagent/executor/CLI types passed. The scoped source manifests match the candidate. These are distinct populations, not an inflated combined test total.

Remaining gates are explicit. The issued-unknown instruction generation cleanup negative reproduced on the unmodified baseline and still needs the instruction-owner integration check. Default CLI ordinary delivery has generic admission only, so no typed receipt or automatic completion wake was claimed there. Historical run011 and DS04–06 evidence remains separate. The next event units cover active observation release, other genuine producer sources, scoped UI subscriptions and remaining watcher/platform polling.

Detailed evidence and independent reviews are retained in `.superpowers/sdd/2026-10-29-event-completion-map/`. No release, push or version/Session-format change occurred.
