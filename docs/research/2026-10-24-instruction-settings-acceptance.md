# IB settings seam scoped acceptance

Root accepted full `bdc1e05c78dee2c6f100feb725e5a9561487a93b..fe0174d5f8124d92ba3728c6046d1908844e9079` after fresh GPT6Astra spec/quality review. The scope is settings policy, explicit legacy import and its transaction/publication semantics, not the complete instruction feature.

- [Implementation and boundary report](instruction-settings-review-20261024/task-3-report.md).
- [Independent review: approved, no actionable finding](instruction-settings-review-20261024/task-3-review.md).
- [Root source/commit/dependency audit](instruction-settings-review-20261024/task-3-root-audit.json) and [audit script](instruction-settings-review-20261024/task-3-root-audit.mjs).

The required six-file suite passed140tests, including44new instruction controls; settings typecheck passed. Root checked34physical source/test files through all four inventories and13changed files against actual committed Git blobs, plus the three actual package dependency resolutions:0mismatches. Causal policy-loss/premature-publication and queued stale-revision failures were retained; initial nonconfigurable-spy failures are setup-invalid, not causal evidence.

Saved policy distinguishes absent native defaults from explicit empty/custom sources. Import is an explicit, digest-bound operation on an identified profile; it preserves legacy winner order, provenance, raw comments/unknown layered fields and higher policy. Writes publish in-memory state and revisions only after successful rename, and guarded section edits recheck revision within the same queue. Reset retains historical import provenance but restores native policy.

Approved compatibility decisions remain visible: a present higher-layer instructions section is a whole policy; unmarked profiles do not silently probe foreign home rules; explicit-files mode requires host-selected profile identity. The digest check is not filesystem compare-and-swap; the eventual host must provide exclusive migration ownership. IG must expose preview/apply and explain policy changes, while IC-B consumes saved effective policy before scope replacement. No watcher, actual model request, child integration, reachability or release gate is closed by this acceptance.
