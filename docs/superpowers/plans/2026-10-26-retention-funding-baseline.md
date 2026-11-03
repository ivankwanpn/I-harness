# Retained-result funding — bounded current-source measurement

> Use a root-assigned GPT-6.1 Sol worker on the recorded isolated checkout. This packet permits test-only measurement, not the aggregate funding product optimization. No recursive agents.

**Goal:** Determine the remaining allocation-inventory work and current bounded owner latency after accepted expiry/index repairs, so the next performance change follows evidence.

**Spec:** Existing [retention performance constraints](../specs/2026-10-25-legacy-retention-performance.md), especially LP01–08, plus this packet's narrower reservation. [Derived-index acceptance](../../research/2026-10-26-derived-index-owner-acceptance.md) is the actual baseline. Historical1001-ref487.808s is not a current result.

## Constraints and interfaces

- Product0.1.13-rc.1 / current MAIN Session12; no product, wire, format, quota, policy, index, funding or source-authority change. D1a's separate protocol checkout is not this baseline.
- Use the actual `legacyFixture({distinct,observations,summary:true})` and its real `run()` B2/project/legacy owner path. `observations` repeats **per ref**: total rows are `distinct * observations`.
- Exactly three instrumented layouts: `{distinct:11,observations:1}`, `{distinct:31,observations:1}`, `{distinct:1,observations:101}`. No distinct101,1001 or10001 run. Keep payload, summary, topology, retention and quota at the existing fixture defaults; no alternate oracle to improve timing.
- Exactly two independent-process uninstrumented samples: D11/R11 and D31/R31. These are single observations, not medians or an achieved performance gate. No profiler, sampling loop, warmup loop or implicit retry.
- Preserve original methods/promises/errors/handles and file identity checks. Instrumentation issues no extra filesystem queries and cannot replace physical inventory, body reads, hashing, sync, close, source policy or result publication.
- Separate setup, initial confirmation, allocation helpers, application pending, later owner application, page publication, final proof and teardown. Counts are structural evidence. Nested elapsed spans are not added as exclusive cost or subtracted to manufacture uninstrumented time.
- Root assigns one runtime/writer. Sequential package-CWD Vitest with --maxWorkers=2 --minWorkers=1, fresh six IH evidence/config roots. Protected preexisting HOST Gateway diagnostic remains unread/unrun/unenumerated/unhashed/unchanged. No live provider/account, dependency installation, global environment change, push/tag/release or default-suite poisoning.

## Task 1: Measure current funding without changing its product behavior

**Owned test paths:** create `packages/context-output/test/measurement/retention-funding.baseline.ts` and `retention-funding-timing.baseline.ts`. A dedicated evidence-owned Vitest config selects only these exact files. They are excluded from ordinary `*.test.ts` discovery. Extend existing `test/helpers/legacy-performance-probe.ts` only where necessary for transparent counters/phases; preserve its existing behavior and accepted tests. No product paths are owned.

**Actual fixture contract:** `legacyFixture` returns `run`, `close`, `root`, `selectedRefs`, `service`, `observation`, `reopen`, `sourceCalls`, `acquired` and original request/phase facts. Reuse existing original canonical membership/body/read assertions rather than manufacturing an owned service or empty permission port.

```ts
const cases = [
  { name: 'd11-r11', distinct: 11, observations: 1 },
  { name: 'd31-r31', distinct: 31, observations: 1 },
  { name: 'd1-r101', distinct: 1, observations: 101 },
] as const
// For each actual fixture, setup is outside owner timing.
const fixture = await legacyFixture({ distinct, observations, summary: true })
try {
  const started = performance.now()
  const result = await fixture.run()
  const ownerMs = performance.now() - started
  expect(result.kind).toBe('ready')
  // Store ownerMs, exact original counts and phase counters before assertions/cleanup.
  // Apply the existing canonical target-owner, body-hash/read and zero-active-I/O assertions.
} finally { await fixture.close() }
```

- [ ] Freeze exact source/Node/host/fixture parameters and named selector population before any runtime. Record new test/instrumentation bytes separately from unchanged product Git/raw hashes.
- [ ] Extend transparent observation around actual phase boundaries. The current old marker sets funding on every confirmLegacyIndex, including final proof; do not reuse that marker as exclusive allocation attribution. Distinguish native index confirmation/admission inventories from the original slot/ledger/application allocations. If a precise boundary cannot be observed without product edits, return that concrete gap to root rather than estimate it as measured.
- [ ] Run the three instrumented cases once. Record physical inventories and recursive entry/stat counts, original file opens/read bytes/sync/closes, distinct reserve/ledger effects, graph rows, body hash/read equality, original source/target membership, handles/pending I/O and cleanup disposition. Each method wrapper forwards exact results and errors. Save complete raw output and phase data.
- [ ] Evaluate the future target `allocationInventories <= 2` against those exact actual observations in a separate explicit assertion/receipt. Preserve its expected baseline failure; do not add a failing default test or claim this count alone proves elapsed dominance.
- [ ] Run D11 and D31 each once in a separate Node/Vitest process with no measurement wrappers/prototype hooks loaded. Same fixture/parameters and correctness assertions; setup/owner/assertions/cleanup durations separate. Record process-cold versus unmeasured disk cache state honestly.
- [ ] Check ordinary test discovery still excludes the two explicit baseline files, run affected test-source typecheck, and run the existing bounded performance controls only if helper behavior changed. No broad ContextOutput/native qualification repeat for measurement-only work.
- [ ] Freeze test-only commit and report exact BASE/HEAD, source identities, actual commands/outputs, failures/setup issues and comparison to the source-model `5D+6` allocations. Explain extra scans separately instead of relabeling them to fit the formula. Root reviews the measurement before authorizing any product optimization.

## Decision after measurement

If current data supports D-dependent allocation inventories as a useful next target, root freezes the existing Task3 same-turn aggregate funding design with phase-aware original allocation/recovery. If it does not, return the evidence and strongest actual residual; do not expand into index/page/body-policy work. No free-space cache, mutable reserve balance, skipped native fact, whole-graph authority cache or changed thresholds is authorized by this packet.
