# Linear content reads for canonical/rewrite padding

Root-approved R6 follow-on to the scoped funding acceptance. Product0.1.13-rc.1, Session13, all public formats/authority unchanged. This is the explicit R5 contract decision, not a claim that the previous before-every-request content guarantee was already linear.

## Decision and changed guarantee

Choose option B from `.superpowers/v0113-integrated-delivery-20261023/funding-prefix-cost-decision-20261026.md`, only for the canonical and independent rewrite append-padding paths. Existing ordinary non-batch pad never reread the growing prefix; the new batch path retains stronger native checks and validates exact contents at entry and final boundaries. Full prefix reads before every bounded append necessarily cost quadratic bytes. A fixed writev vector only reduces a constant and is not the selected solution.

At the acquired handle, verify the full original prefix against its freshly captured description before any write. Before every append retain owned path, original reliable native identity, original single-link rule, exact expected size, current Store/turn/lease/IndexUse/allocation and immediate primitive issuance. Append only bounded8KiB spaces, advancing the rolling expected hash by acknowledged positive bytesWritten. At final capacity require a full hash equal to validated original prefix plus those acknowledged spaces BEFORE sync; repeat full content/native readback AFTER sync before confirming the local FundingFile, entry or batch success. No-growth pads also retain entry/final validation.

Same-inode, same-size external content drift after entry can now be detected at final pad validation, after further already-admitted appends. This explicitly amends the canonical/rewrite portion of funding spec§4/§6; it is an additional late-detection boundary, not merely first-pass/second-pass transcript drift. Own extra growth after that cut is bounded by the remaining C−offset within the already-charged primitive and X≤G. No byte below the original size S is overwritten. A mismatch stops before that pad's sync and every subsequent primitive/entry/grant/application completion. Earlier valid effects, external corruption and actual appended bytes remain and are charged; no rollback/refund/repaired success is invented. A post-sync mismatch retains the issued sync as an unknown/failed effect.

Native identity/link/size/phase/operation/currentness and X/G violations still refuse before the offending request. **Journal padding and journal overwrites, slots and application pending keep their existing per-request content checks.** R1 actual-handle requireOne, R2 every journal write issuance and R3 committed-recovery hook remain binding. No snapshot nlink2 can become permission. Existing application hardlink rules remain distinct.

These are observed-boundary guarantees, not external-writer exclusion or continuous immutable bytes. A streamed final read is not an atomic snapshot; arbitrary outside mutation during/after a scan or mutate-and-restore may evade detection. Supported writers remain excluded by the actual original lock. No timestamps/stat-only digest cache, sampling, imagined native file lock, new platform helper, persisted digest authority, D-sized table or capacity-sized buffer may replace the full reads.

## Exact scope and owner

- Product: only `packages/context-output/src/legacy/owner-ledger.ts`, private `padInBatch` canonical/rewrite loop. Signature unchanged.
- Tests: `test/legacy-funding-batch.test.ts`; optional narrow counters in `test/helpers/legacy-funding-observer.ts`. Actual original operations and results/errors must be forwarded.
- No changes to funding-batch authority/arithmetic, Store, fork placement, ordinary pad/fund/recover/replace, capture, quota, native index policy, SQL, task/record formats, public exports, source/target grants, journal/slot/application behavior or F1/O1 owners.

Root ruling LPF01 changes only the content timing guarantee described above. Cost if wrong is extra append growth in an owned nlink1 file before rejection; it never permits early success or later grant. Preserve all acquired-resource joins and primary plus independent cleanup failure. Every issued request still belongs to the actual original owner. Keep the per-entry produced identity and final transcript/T1 gates; no allowance survives callback failure or retirement.

## Required correctness and cost evidence

1. Entry same-inode content drift (including valid JSON whitespace), wrong size/link/identity and invalid currentness reject before first growth.
2. After one real append, alter an original-prefix byte or an acknowledged appended space without changing inode/size. Exercise canonical and rewrite. Later appends may complete; final content mismatch must occur before sync, next primitive, finish or any new grant. Check exact retained alteration and acknowledged spaces, original usage and no fabricated rollback.
3. After the first request, inode replacement, actual outside hardlink, shrink/extension, cancelled currentness and expired original allocation must prevent the next request. Keep a snapshot-already-nlink2 negative. Outside bytes remain unchanged.
4. Real short writes, zero progress, write-then-reject, sync-then-reject and close failure preserve original outcomes/bytes/retirement. Expected hash includes acknowledged bytes only. A thrown-after-write outcome remains failed even if bytes physically landed.
5. Final-before-sync and post-sync content corruption refuse at their actual boundary; no-growth pads retain full content checks. Preserve existing journal R1–R3, zero-growth-journal-prefix, original recovery and retained-partial exact-fit/one-below controls.
6. Explicitly replace only the existing canonical `same-handle-repeated-prefix-canonical` assertion that required exactly one write with the new bounded late-detection oracle. Keep its real mutation and exact retained/grant assertions. Do not relax unrelated timing or prefix oracles.
7. Actual connected Store/creating lease/current IndexUse, original rows/transcript, X/G/T0/T1, selected/omitted owner and body readback remain required. No helper-only success or mock inventory/readiness.

Root authorizes structural counter controls with smallD only: canonical/rewrite capacities32KiB and64KiB under the actual owner, plus a small-capacity short-write case (at most1KiB missing growth for1/7-byte continuations). Observe forwarded actual hash/read bytes and phases, actual writes/acknowledged bytes, native/allocation/issuance counts and cleanup. New canonical/rewrite loop hash bytes must be0; the fixed entry/pre-sync/post-sync full-read envelope must follow the actual frozen call map and stay O(S+C), independent of request count. Native checks must cover every request. Retain separate snapshots, parsing and original all-owner work; linear pad reads are not a linear whole-fork or latency claim.

LPF02 actual Store fixture correction: this transfer adds one actual target owner; the standard target adds9bytes, so canonical multi-full-chunk growth is not a reachable setup for that fixture. Use32/64KiB existing canonical/no-growth scans with full-growth independent rewrite, and actual≤1KiB canonical additions split into1/7-byte writes for continued-write drift. Canonical late-growth oracle uses the exact remaining admitted bytes; rewrite covers more than two full chunks. Do not manufacture a large next-owner set, broaden IDs/owner policy or grant fake additional owners to force the originally sketched shape.

These are correctness/cost-counter tests, not wall-clock benchmarks. No101/1001/10001 run is authorized. Original LP08 latency gates remain unchanged and require later root reservation. Do not make a speedup claim from counters alone.
