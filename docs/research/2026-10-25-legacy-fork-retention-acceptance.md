# F1-L1 legacy fork retention — scoped acceptance

The connected owner slice is accepted and integrated. Donor f2726707915c940efe64d4ebe2e6b0cc8980f72b..7c1ee4536fdec6ff8ad73beedfd47cfc839ca79b comprises the original implementation2bd11d06, capacity control16f7c0ba and reviewed correction7c1ee453. MAIN integrates them as1547a617,79aaa14f,bc83c399. Product remains0.1.13-rc.1, Session format12.

## Behavior accepted

The existing L0 store and quota owner now retain bounded original transfer pages, complete reference commitments and original publication/disposition state. Full metadata is committed by streaming digest/count/expiry rather than duplicated descriptor graphs; there is no total-reference cap. Managed and legacy data share actual physical funding. Source-bound warm recovery joins the original operation, and cold observed reads retain original recipient, revocation, expiry and metadata checks. Source clear preserves legitimate target ownership; target/global clear and expiry revoke it. B2-owned preparation facts bind the selected source coordinates to its actual target seed/manifest.

The review correction fences foreign paths before mutation, validates native independent file identity, installs cleanup ownership before listener registration, rejects explicit null lineage and validates original committed authority before startup/expiry reclamation. These close four findings and two evidence gaps in the initial review. Same-reviewer [fix review](legacy-fork-retention-20261025/task-1-fix1-review.md) approves the owner-slice corrections with no outstanding actionable fix-round findings. The original [review](legacy-fork-retention-20261025/task-1-review.md) and complete [implementation report](legacy-fork-retention-20261025/task-1-report.md) remain preserved.

## Verification and its limits

- Donor final fast ContextOutput gate104:33 files,267 passed, one intentionally unrerun10001 test; distinct-scale file excluded. Final witness strengthening105:4 passed; final source/test types106:exit0. Core types101:exit0. These overlapping totals are not summed.
- MAIN bc83c399 first fast invocation:32 passing files/266 passing tests, one intentional10001 skip, but one dependency-membership suite failed collection because its default evidence directory was already sealed. This invocation is **not green**.
- With only that isolated evidence-root setup corrected, MAIN reran the missing dependency-membership suite:1 passed. Executor original-store-close/cold-reader/native/quota integration:4 files/13 passed. ContextOutput and Gateway types:exit0. The code stayed unchanged across the first and followup gates. This is split fixed-source coverage, not a claim of one full green invocation.
- Root [audit](legacy-fork-retention-20261025/root-audit.json) checks39 donor source-manifest entries,36 integrated Git blobs and189 receipt/evidence files, with zero audit failures. Both [initial](legacy-fork-retention-20261025/integration-initial.json) and [followup](legacy-fork-retention-20261025/integration-setup-followup.json) records preserve exact commands, environment, source counts and exits.
- The initial096 witness negatives used a closed broker and are excluded from causal proof. The corrected live-target controls and distinct fresh-scope warm positive remain separately qualified. Raw093/095/099 failures and setup failures are retained.
- Earlier10001-observation control:101 leaf pages,22170 real file retirements, peak1/live0; functional and lifetime evidence on its recorded source. The earlier1001-distinct-ref owner took487.808s plus85.100s setup. Neither is a final-source latency certificate. No expensive unchanged scale test was repeated for integration.

## Remaining work

Public SDK/CLI/Gateway/Desktop semantic fork wiring is still F1-C; the original persistence semantic-fork RED remains its debt. Merely adding the owner API does not close that public path. Child/spawn and instruction inheritance remain separate connected tasks.

R6 must address and qualify repeated inventories and startup/expiry authority validation. The reviewed expiry path can perform O(expiring references × retained observations) repeated work; the1001-ref measurement is far too slow to count as usable long-session delivery. Optimization must keep original authority, quota, witness and cancellation/lifetime semantics; no new hard reference cap or second truth is authorized.

Native N2 code remains outside MAIN, with open Code Mode recovery qualification. Full event delivery, instruction integration, fixed-HEAD package flows and whole-version gates remain required. This acceptance neither publishes a release nor declares the entire R4B/native/0.1.13 program complete.
